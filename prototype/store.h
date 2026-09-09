// turbocache L2 arena prototype.
//
// One open-addressed index, two data allocators behind it:
//   MODE_SLAB : size-class free lists + CLOCK eviction   (memcached-style)
//   MODE_LOG  : circular append-only log, evict from tail (FIFO-ish)
//
// The primary is the sole writer; workers map the segment PROT_READ and use the
// per-entry seqlock to detect torn reads. This prototype exercises both roles.
#pragma once
#include <atomic>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include "platform.h"
#include "vendor/rapidhash.h"

static const uint32_t TC_MAGIC = 0x54430001;
static const uint32_t TC_LAYOUT = 1;
static const uint32_t FEATURE_LZ4 = 1;
static const uint64_t HASH_EMPTY = 0;
static const uint64_t HASH_TOMB  = 1;
// Ring sentinel: 'drop your entire L1', used by clearAll.
static const uint64_t RING_FLUSH_ALL = 0xFFFFFFFFFFFFFFFFull;

enum { MODE_SLAB = 0, MODE_LOG = 1, MODE_LOG2 = 2 };  // LOG2 = log + second-chance re-append

// Value type travels WITH the bytes, so a worker reading the arena directly
// reconstructs the right JS type. Without this, non-string primitives lived
// only in L1: lost on eviction and invisible to other processes.
enum { FLAG_COMPRESSED = 1, FLAG_STRING = 2, FLAG_LATIN1 = 4,
       FLAG_NUMBER = 8, FLAG_BOOL = 16, FLAG_NULL = 32, FLAG_BIGINT = 64,
       FLAG_BINARY = 128 };   // Buffer / TypedArray / ArrayBuffer / DataView

// 40 bytes, 8-byte aligned. Key bytes then value bytes follow inline.
struct Entry {
  std::atomic<uint32_t> seq;   // even = stable, odd = write in progress
  uint32_t slot;               // owning index slot, so eviction can unlink
  uint64_t hash;
  uint32_t version;
  uint32_t expiresAt;
  uint32_t rawLen;
  uint32_t storedLen;
  uint32_t blockSize;          // total bytes incl. header (slab class size, or log record size)
  uint16_t keyLen;
  uint8_t  flags;
  uint8_t  ns;          // namespace id, 0 = default
};

struct IndexSlot {
  std::atomic<uint64_t> hash;  // 0 empty, 1 tombstone, else hash
  // MONOTONIC log position of the entry, not a physical offset. Physical
  // address is pos & (dataBytes-1). Because the position never wraps, a reader
  // can prove a record has not been evicted by checking logTail <= pos, which a
  // physical offset cannot express (offsets are reused every time the log wraps).
  std::atomic<uint64_t> off;
};

struct RingRec { uint64_t hash; uint32_t version; uint16_t writerId; uint16_t _pad; };

// Index load factor above which an insert evicts first, so the index can never
// saturate before the data region does (which silently failed inserts before).
static const double MAX_LOAD = 0.75;
static const uint64_t MIN_DATA_BYTES = 1u << 16;

#define NCLASS 32
#define NS_MAX 16
#define NS_NAMELEN 24

struct Header {
  uint32_t magic, layout;
  uint8_t  mode;
  uint8_t  _pad[7];
  uint64_t totalBytes;
  uint64_t indexOff;  uint64_t indexSlots;   // power of two
  uint64_t dataOff;   uint64_t dataBytes;
  uint64_t ringOff;   uint64_t ringCap;      // power of two
  uint64_t hintsBytes;                       // size of the separate hints segment
  uint64_t epochMs;                // arena creation time; expiries are ms from here
  std::atomic<uint64_t> tailPub;   // logTail, republished for readers
  std::atomic<uint64_t> ringHead;
  std::atomic<uint64_t> heartbeatNs;

  // slab state
  uint32_t classSize[NCLASS];
  uint64_t freeHead[NCLASS];   // offset+1 of first free block, 0 = none
  uint64_t bumpPtr;            // unallocated frontier in the data region
  uint64_t clockHand;

  // log state
  uint64_t logHead, logTail;   // monotonic byte counters; & (dataBytes-1) to index

  // stats
  uint64_t inserts, evictions, live, liveBytes, allocBytes;
  uint64_t maxLive, indexEvictions, shiftMoves;

  // Namespaces. Without quotas a hot namespace evicts a cold one and neither
  // can be sized or cleared on its own. Quotas are SOFT and enforced through
  // the second-chance path: at the tail, an entry of an under-quota namespace
  // gets another lap, an over-quota one is dropped. Progress is guaranteed
  // whenever the quotas sum to no more than capacity, since a full arena then
  // always contains at least one over-quota namespace.
  uint32_t nsCount;
  char     nsName[NS_MAX][NS_NAMELEN];
  uint64_t nsBytes[NS_MAX];
  uint64_t nsQuota[NS_MAX];          // 0 = no quota, competes freely
  uint64_t nsProtected[NS_MAX], nsDropped[NS_MAX];
  uint64_t reappends, reappendSkippedNoRoom, dropped, tailAdvances, tailLive;
  // Set the first time a compressed entry is written. An attaching process
  // built without LZ4 cannot read those entries, so it refuses the arena
  // rather than silently reporting misses.
  uint32_t features;
  uint64_t readsSkippedNoLz4;
};

struct Store {
  uint8_t *base = nullptr;
  size_t   mapBytes = 0;
  bool     writable = false;
  Header  *h = nullptr;
  IndexSlot *idx = nullptr;
  uint8_t *data = nullptr;
  RingRec *ring = nullptr;
  // Reference bits: the ONLY thing a worker may write. Genuinely concurrent -
  // the primary clears and relocates them while every worker sets them - so
  // they are atomics. Relaxed is enough: a lost or stale hint costs eviction
  // quality, never correctness, and a relaxed byte access compiles to a plain
  // load/store. TSAN flagged the plain-uint8_t version as a data race.
  std::atomic<uint8_t> *hints = nullptr;
  std::atomic<uint8_t> *hintsMap = nullptr;
  size_t   hintsMapBytes = 0;
  char     name[64] = {0};
  char     hintsName[80] = {0};
  int      attachError = 0;   // 1 = arena needs LZ4 and this build lacks it
  ShmHandle baseHandle, hintsHandle;

  inline Entry *entryAt(uint64_t pos) const { return (Entry *)(data + (pos & (h->dataBytes - 1))); }
  inline uint8_t *keyOf(Entry *e) const { return (uint8_t *)e + sizeof(Entry); }
  inline uint8_t *valOf(Entry *e) const { return (uint8_t *)e + sizeof(Entry) + e->keyLen; }

  // ---- lifecycle -------------------------------------------------------
  bool create(const char *nm, uint64_t totalBytes, uint64_t indexSlots, uint8_t mode) {
    if (indexSlots < 16 || (indexSlots & (indexSlots - 1))) return false;   // power of two
    snprintf(name, sizeof(name), "%s", nm);
    base = (uint8_t *)shmCreate(nm, totalBytes, &baseHandle);
    if (!base) return false;
    mapBytes = totalBytes; writable = true;
    memset(base, 0, sizeof(Header));

    h = (Header *)base;
    h->magic = TC_MAGIC; h->layout = TC_LAYOUT; h->mode = mode;
    h->totalBytes = totalBytes;
    h->indexOff = (sizeof(Header) + 63) & ~63ull;
    h->indexSlots = indexSlots;
    uint64_t indexBytes = indexSlots * sizeof(IndexSlot);
    h->ringOff = h->indexOff + indexBytes;
    // Ring capacity is a TIME budget, not a count. A worker that fails to drain
    // before the head laps it must flush its entire L1, and the head is
    // appended only by the primary, so its rate is the primary's apply rate -
    // measured at ~650k records/s. 8192 records was therefore only ~12.7ms of
    // headroom, about one minor GC; a major GC would flush every worker's L1.
    // 65536 records is 1MB and ~100ms, which covers a major GC, capped at 4% of
    // the arena so a small arena does not spend itself on the ring.
    {
        uint64_t want = 65536, byArena = (uint64_t)(totalBytes * 0.04) / sizeof(RingRec);
        uint64_t cap = want < byArena ? want : byArena;
        uint64_t p = 8192; while (p * 2 <= cap && p < 262144) p *= 2;
        h->ringCap = p;
    }
    uint64_t ringBytes = h->ringCap * sizeof(RingRec);
    uint64_t pg = platformGranularity();
    h->hintsBytes = (indexSlots + pg - 1) & ~(pg - 1);      // one byte per index slot
    h->dataOff = (h->ringOff + ringBytes + 63) & ~63ull;

    // Metadata must actually fit, with room left for data. Without this check a
    // too-small segment underflows `totalBytes - dataOff` into a huge unsigned
    // value and create() hangs or scribbles past the mapping.
    if (h->dataOff + MIN_DATA_BYTES > totalBytes) {
      shmClose(base, totalBytes, &baseHandle); base = nullptr; shmUnlink(nm); return false;
    }
    // MODE_LOG masks with (dataBytes-1), so the data region must be a power of two.
    // Both modes are rounded identically so the two allocators compete at equal capacity.
    uint64_t avail = totalBytes - h->dataOff;
    { uint64_t p = 1; while (p * 2 <= avail) p *= 2; avail = p; }
    h->dataBytes = avail;

    // size classes, growth factor 1.25 (memcached-style) to bound internal waste
    uint32_t sz = 64;
    for (int i = 0; i < NCLASS; i++) {
      h->classSize[i] = sz;
      h->freeHead[i] = 0;
      uint32_t next = (uint32_t)(sz * 1.25);
      sz = (next + 7) & ~7u;
      if (sz <= h->classSize[i]) sz = h->classSize[i] + 8;
    }
    h->bumpPtr = 0; h->clockHand = 0; h->logHead = 0; h->logTail = 0;
    h->tailPub.store(0, std::memory_order_relaxed);
    h->epochMs = nowMs();
    h->maxLive = (uint64_t)(indexSlots * MAX_LOAD);
    if (!openHints(nm, true)) return false;
    bind();
    memset(idx, 0, indexBytes);
    memset(hints, 0, h->hintsBytes);
    return true;
  }

  bool attachReadOnly(const char *nm) {
    uint64_t sz = 0;
    base = (uint8_t *)shmOpenRead(nm, &baseHandle, &sz);
    if (!base) return false;
    mapBytes = (size_t)sz; writable = false;
    h = (Header *)base;
    if (h->magic != TC_MAGIC || h->layout != TC_LAYOUT) {
      shmClose(base, mapBytes, &baseHandle); base = nullptr; return false;
    }
    // Refuse an arena holding compressed entries this build cannot decompress,
    // rather than attaching and reporting silent misses for them.
#ifndef TURBOCACHE_LZ4
    if (h->features & FEATURE_LZ4) {
      shmClose(base, mapBytes, &baseHandle); base = nullptr; attachError = 1; return false;
    }
#endif
    // Hints live in their OWN segment, opened read-write. The arena fd above is
    // O_RDONLY, so a worker cannot map the arena writable even deliberately -
    // the isolation is a property of the descriptor, not just of the mapping.
    if (!openHints(nm, false)) return false;
    bind();
    return true;
  }

  void bind() {
    idx   = (IndexSlot *)(base + h->indexOff);
    ring  = (RingRec *)(base + h->ringOff);
    data  = base + h->dataOff;
    hints = hintsMap;
  }

  // The hints segment is advisory data only: losing it costs eviction quality,
  // never correctness.
  bool openHints(const char *nm, bool create) {
    char hn[80];
    snprintf(hn, sizeof(hn), "%.60s.h", nm);
    if (create) snprintf(hintsName, sizeof(hintsName), "%s", hn);
    hintsMapBytes = h->hintsBytes;
    hintsMap = (std::atomic<uint8_t> *)shmOpenRW(hn, hintsMapBytes, create, &hintsHandle);
    if (!hintsMap) return false;
    return true;
  }

  void destroy() {
    if (hintsMap) { shmClose(hintsMap, hintsMapBytes, &hintsHandle); hintsMap = nullptr; }
    if (base) shmClose(base, mapBytes, &baseHandle);
    if (writable && name[0]) shmUnlink(name);
    if (writable && hintsName[0]) shmUnlink(hintsName);
    base = nullptr;
  }

  // ---- index -----------------------------------------------------------
  // Linear probe. Returns slot index holding `hash` with a matching key, or -1.
  int64_t findSlot(uint64_t hash, const uint8_t *key, uint16_t keyLen) const {
    uint64_t mask = h->indexSlots - 1;
    uint64_t i = hash & mask;
    for (uint64_t probes = 0; probes <= mask; probes++, i = (i + 1) & mask) {
      uint64_t hv = idx[i].hash.load(std::memory_order_acquire);
      if (hv == HASH_EMPTY) return -1;
      if (hv != hash) continue;                     // different key in this slot
      uint64_t pos = idx[i].off.load(std::memory_order_acquire);
      Entry *e = entryAt(pos);
      if (e->keyLen == keyLen && memcmp(keyOf(e), key, keyLen) == 0) return (int64_t)i;
    }
    return -1;
  }

  int64_t findFreeSlot(uint64_t hash) const {
    uint64_t mask = h->indexSlots - 1;
    uint64_t i = hash & mask;
    for (uint64_t probes = 0; probes <= mask; probes++, i = (i + 1) & mask) {
      uint64_t hv = idx[i].hash.load(std::memory_order_relaxed);
      if (hv == HASH_EMPTY || hv == HASH_TOMB) return (int64_t)i;
    }
    return -1;
  }
};
