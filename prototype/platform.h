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
  #include <signal.h>
  #include <errno.h>
  #include <time.h>
  #ifdef __APPLE__
    #include <mach/mach_time.h>
  #endif
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
  // ftruncate on a tmpfs only sizes the object SPARSELY: it succeeds even when
  // the filesystem cannot supply the pages, and the process then takes a SIGBUS
  // the first time it touches one. Docker's /dev/shm defaults to 64MB, so a
  // 192MB arena "created" fine and killed the process minutes later with no
  // diagnosable cause. fallocate actually reserves, so shortfall surfaces here
  // as a clean failure instead.
#if defined(__linux__)
  if (posix_fallocate(fd, 0, (off_t)bytes) != 0) {
    close(fd); shm_unlink(name); return nullptr;
  }
#endif
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

// Is that pid still running? Used to reclaim a submission ring whose owner
// crashed. Signal 0 performs the permission and existence checks without
// delivering anything; EPERM means the process exists but belongs to another
// user, which still counts as alive.
static inline bool platformPidAlive(uint32_t pid) {
#ifdef _WIN32
  HANDLE hp = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)pid);
  if (!hp) return false;
  DWORD w = WaitForSingleObject(hp, 0);
  CloseHandle(hp);
  return w == WAIT_TIMEOUT;
#else
  if (kill((pid_t)pid, 0) == 0) return true;
  return errno == EPERM;
#endif
}

// Owning pid for a claimed submission ring: lets the primary tell a live worker
// from a crashed one without any handshake.
static inline uint32_t platformPid() {
#ifdef _WIN32
  return (uint32_t)GetCurrentProcessId();
#else
  return (uint32_t)getpid();
#endif
}

// A monotonic, system-wide tick clock that COUNTS SUSPEND.
//
// Everything that crosses a process boundary -- the heartbeat and the TTL epoch
// -- used nowNs(), i.e. CLOCK_REALTIME. Two consequences: a forward NTP step
// larger than primaryStaleMs marked a healthy primary dead in every worker at
// once, and a backward step shifted every TTL. Wall clock is the wrong domain
// for "how long since" between processes.
//
// "Just use CLOCK_MONOTONIC" is not portable in the sense we need: on Linux it
// EXCLUDES suspend, on macOS it INCLUDES it (there it is mach_continuous_time).
// Suspend must be counted -- a TTL should still elapse while a laptop sleeps,
// which is what wall-clock TTL meant -- so each platform gets its explicitly
// suspend-counting clock rather than the one with the matching name.
static inline uint64_t ticksNs() {
#if defined(_WIN32)
  // Win10+. Exported from kernel32 but its import library is Mincore.lib, which
  // node-gyp does not link, so resolve it dynamically and keep the gyp file as
  // it is. GetTickCount64 is the pre-Win10 fallback at 15.6ms resolution.
  typedef VOID(WINAPI * QITP)(PULONGLONG);
  static QITP fn = (QITP)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "QueryInterruptTimePrecise");
  if (fn) { ULONGLONG t = 0; fn(&t); return (uint64_t)t * 100ull; }
  return GetTickCount64() * 1000000ull;
#elif defined(__APPLE__)
  static mach_timebase_info_data_t tb = {0, 0};
  if (!tb.denom) mach_timebase_info(&tb);
  return mach_continuous_time() * tb.numer / tb.denom;
#else
  struct timespec ts; clock_gettime(CLOCK_BOOTTIME, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
#endif
}
static inline uint64_t ticksMs() { return ticksNs() / 1000000ull; }

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
