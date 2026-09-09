#pragma once
// Platform abstraction for named shared memory and clocks.
//
// POSIX shared memory is PERSISTENT: it survives until shm_unlink, which is why
// a crashed primary used to leak a segment. A Windows file mapping is
// REFERENCE-COUNTED: it dies when the last handle and view close. The two
// therefore disagree about whether an arena can outlive its creator, and this
// header does not paper over that - see shmUnlink and the note in shmCreate.
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
  #define NOMINMAX
  #endif
  #include <windows.h>
  #include <time.h>
#else
  #include <sys/mman.h>
  #include <sys/stat.h>
  #include <fcntl.h>
  #include <unistd.h>
  #include <time.h>
#endif

struct ShmHandle {
#ifdef _WIN32
  HANDLE h = nullptr;
#else
  int fd = -1;              // closed immediately after mapping; kept for symmetry
#endif
};

#ifdef _WIN32
// POSIX callers pass "/name". Windows named objects want a namespace prefix;
// Local\ is per-session, which is the right scope for a cluster. Global\ would
// need SeCreateGlobalPrivilege.
static inline void tcWinName(const char *posix, char *out, size_t cap) {
  const char *bare = (posix && posix[0] == '/') ? posix + 1 : posix;
  snprintf(out, cap, "Local\\%s", bare ? bare : "");
}
#endif

// Create a fresh writable mapping. Returns the base pointer or nullptr.
static inline void *shmCreate(const char *name, uint64_t bytes, ShmHandle *out) {
#ifdef _WIN32
  char wname[160]; tcWinName(name, wname, sizeof(wname));
  HANDLE h = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                (DWORD)(bytes >> 32), (DWORD)(bytes & 0xFFFFFFFFull), wname);
  if (!h) return nullptr;
  // Unlike POSIX we cannot unlink an object others still hold, so an existing
  // one means another primary is live. Failing is the honest answer - and it
  // catches the two-primaries case POSIX silently allowed by unlinking first.
  if (GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(h); return nullptr; }
  void *base = MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, 0);
  if (!base) { CloseHandle(h); return nullptr; }
  out->h = h;
  return base;
#else
  shm_unlink(name);                       // reclaim a crashed run's segment
  int fd = shm_open(name, O_CREAT | O_RDWR | O_EXCL, 0600);
  if (fd < 0) return nullptr;
  if (ftruncate(fd, (off_t)bytes) != 0) { close(fd); shm_unlink(name); return nullptr; }
  void *base = mmap(nullptr, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if (base == MAP_FAILED) { shm_unlink(name); return nullptr; }
  out->fd = -1;
  return base;
#endif
}

// Open an existing mapping READ-ONLY. The read-only guarantee is meant to be
// enforced by the OS, not by convention: on POSIX the descriptor itself is
// O_RDONLY, and on Windows the handle carries only FILE_MAP_READ rights, so a
// writable view cannot be created from it even deliberately.
static inline void *shmOpenRead(const char *name, ShmHandle *out, uint64_t *sizeOut) {
#ifdef _WIN32
  char wname[160]; tcWinName(name, wname, sizeof(wname));
  HANDLE h = OpenFileMappingA(FILE_MAP_READ, FALSE, wname);
  if (!h) return nullptr;
  void *base = MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0);   // 0 = whole object
  if (!base) { CloseHandle(h); return nullptr; }
  MEMORY_BASIC_INFORMATION mbi;
  *sizeOut = VirtualQuery(base, &mbi, sizeof(mbi)) ? (uint64_t)mbi.RegionSize : 0;
  out->h = h;
  return base;
#else
  int fd = shm_open(name, O_RDONLY, 0600);
  if (fd < 0) return nullptr;
  struct stat st;
  if (fstat(fd, &st) != 0) { close(fd); return nullptr; }
  void *base = mmap(nullptr, (size_t)st.st_size, PROT_READ, MAP_SHARED, fd, 0);
  close(fd);
  if (base == MAP_FAILED) return nullptr;
  *sizeOut = (uint64_t)st.st_size;
  out->fd = -1;
  return base;
#endif
}

// Open or create a writable mapping (used for the hints segment).
static inline void *shmOpenRW(const char *name, uint64_t bytes, bool create, ShmHandle *out) {
#ifdef _WIN32
  char wname[160]; tcWinName(name, wname, sizeof(wname));
  HANDLE h;
  if (create) {
    h = CreateFileMappingA(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                           (DWORD)(bytes >> 32), (DWORD)(bytes & 0xFFFFFFFFull), wname);
    if (h && GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(h); return nullptr; }
  } else {
    h = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, wname);
  }
  if (!h) return nullptr;
  void *base = MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, 0);
  if (!base) { CloseHandle(h); return nullptr; }
  out->h = h;
  return base;
#else
  int fd;
  if (create) {
    shm_unlink(name);
    fd = shm_open(name, O_CREAT | O_RDWR | O_EXCL, 0600);
    if (fd < 0) return nullptr;
    if (ftruncate(fd, (off_t)bytes) != 0) { close(fd); shm_unlink(name); return nullptr; }
  } else {
    fd = shm_open(name, O_RDWR, 0600);
    if (fd < 0) return nullptr;
  }
  void *base = mmap(nullptr, (size_t)bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if (base == MAP_FAILED) return nullptr;
  out->fd = -1;
  return base;
#endif
}

static inline void shmClose(void *base, uint64_t bytes, ShmHandle *h) {
#ifdef _WIN32
  (void)bytes;
  if (base) UnmapViewOfFile(base);
  if (h && h->h) { CloseHandle(h->h); h->h = nullptr; }
#else
  (void)h;
  if (base) munmap(base, (size_t)bytes);
#endif
}

// POSIX must unlink or the segment outlives the process. Windows reference
// counts, so the object is already gone once the last view and handle close -
// there is nothing to unlink and nothing to leak.
static inline void shmUnlink(const char *name) {
#ifdef _WIN32
  (void)name;
#else
  shm_unlink(name);
#endif
}

// Windows map views must start on an allocation-granularity boundary (64KB),
// which is coarser than a page. Callers aligning an offset must use this.
static inline uint64_t platformGranularity() {
#ifdef _WIN32
  SYSTEM_INFO si; GetSystemInfo(&si);
  return (uint64_t)si.dwAllocationGranularity;
#else
  return (uint64_t)sysconf(_SC_PAGESIZE);
#endif
}

static inline uint64_t nowNs() {
#ifdef _WIN32
  FILETIME ft; GetSystemTimeAsFileTime(&ft);
  uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;  // 100ns units
  return t * 100ull;
#else
  struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
#endif
}
static inline uint64_t nowMs() { return nowNs() / 1000000ull; }

static inline void platformSleepUs(unsigned us) {
#ifdef _WIN32
  Sleep(us / 1000 ? us / 1000 : 1);
#else
  usleep(us);
#endif
}
