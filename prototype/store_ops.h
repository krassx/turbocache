#pragma once
#include "store.h"

// Test hook: simulate the real topology, where reads happen in workers holding a
// PROT_READ mapping and therefore CANNOT set reference bits.
static bool g_suppressRefBit = false;

static inline uint64_t align8(uint64_t v) { return (v + 7) & ~7ull; }

struct ReadResult {
  bool     hit = false;
  uint32_t rawLen = 0, storedLen = 0;
  uint8_t  flags = 0;
  uint8_t *buf = nullptr;   // caller-owned scratch, filled with stored bytes
};

// ---------------------------------------------------------------- slab ----
static inline int slabClassFor(Header *h, uint32_t need) {
  for (int i = 0; i < NCLASS; i++) if (h->classSize[i] >= need) return i;
  return -1;
}

// Knuth 6.4 Algorithm R - backward-shift deletion for linear probing.
// Closes the gap by relocating entries instead of leaving a tombstone, so probe
// chains stay at their natural length forever instead of degrading with churn.
//
// Readers run concurrently. A relocated entry may be observed once, or not at
// all if a scan passes its old slot before the move and its new slot after.
// "Not at all" is a miss, never a wrong value, because the key is memcmp-verified.
static bool g_backwardShift = true;   // bisect hook
// Measured: hit rate saturates at 8 re-appends per allocation (85.6% at 0,
// 85.9% at 1, 86.3% from 8 upward, flat to 8192). 16 gives margin at no cost.
static int  g_secondChanceBudget = 16;
// Register (primary) or look up (worker) a namespace by name.
static inline int nsResolve(Store &s, const char *name, uint64_t quota, bool create) {
  Header *h = s.h;
  if (!name || !name[0]) return 0;
  for (uint32_t i = 1; i < h->nsCount; i++)
    if (strncmp(h->nsName[i], name, NS_NAMELEN - 1) == 0) {
      if (create && quota) h->nsQuota[i] = quota;
      return (int)i;
    }
  if (!create) return -1;
  uint32_t id = h->nsCount < 1 ? 1 : h->nsCount;
  if (id >= NS_MAX) return -1;
  snprintf(h->nsName[id], NS_NAMELEN, "%s", name);
  h->nsQuota[id] = quota; h->nsBytes[id] = 0;
  h->nsCount = id + 1;
  return (int)id;
}

static inline void indexRemove(Store &s, uint64_t i) {
  Header *h = s.h;
  if (!g_backwardShift) {               // old behaviour: leave a tombstone
    s.idx[i].hash.store(HASH_TOMB, std::memory_order_release);
    if (s.hints) s.hints[i].store(0, std::memory_order_relaxed);
    return;
  }
  uint64_t mask = h->indexSlots - 1;
  uint64_t j = i;
  for (;;) {
    s.idx[i].hash.store(HASH_EMPTY, std::memory_order_release);
    if (s.hints) s.hints[i].store(0, std::memory_order_relaxed);
    uint64_t hv;
    for (;;) {
      j = (j + 1) & mask;
      hv = s.idx[j].hash.load(std::memory_order_acquire);
      if (hv == HASH_EMPTY) return;
      uint64_t k = hv & mask;                 // home slot of the entry sitting at j
      bool mustStay = (i <= j) ? (i < k && k <= j) : (i < k || k <= j);
      if (!mustStay) break;
    }
    uint64_t pos = s.idx[j].off.load(std::memory_order_relaxed);
    s.idx[i].off.store(pos, std::memory_order_release);
    if (s.hints) s.hints[i].store(s.hints[j].load(std::memory_order_relaxed), std::memory_order_relaxed);
    s.entryAt(pos)->slot = (uint32_t)i;                           // entry tracks its slot
    s.idx[i].hash.store(hv, std::memory_order_release);
    h->shiftMoves++;
    i = j;
  }
}

// Unlink an index slot and (slab only) return its block to the free list.
static inline void unlinkSlot(Store &s, uint64_t slot) {
  Header *h = s.h;
  uint64_t pos = s.idx[slot].off.load(std::memory_order_relaxed);
  indexRemove(s, slot);
  Entry *e = s.entryAt(pos);
  if (h->mode == MODE_SLAB) {
    int cls = slabClassFor(h, e->blockSize);
    if (cls >= 0) {
      *(uint64_t *)((uint8_t *)e + sizeof(std::atomic<uint32_t>)) = h->freeHead[cls];
      h->freeHead[cls] = pos + 1;
    }
  }
  h->live--;
  h->liveBytes -= e->blockSize;
  h->nsBytes[e->ns] -= e->blockSize;
  h->evictions++;
}

// CLOCK: sweep index slots looking for a victim of the requested size class.
// Slab calcification is real and deliberately not hidden here - if no victim of
// the right class exists, the insert fails rather than silently succeeding.
static inline bool slabEvictForClass(Store &s, int cls) {
  Header *h = s.h;
  uint64_t scanned = 0, limit = h->indexSlots * 4;
  while (scanned++ < limit) {
    uint64_t i = h->clockHand;
    h->clockHand = (h->clockHand + 1) & (h->indexSlots - 1);
    uint64_t hv = s.idx[i].hash.load(std::memory_order_relaxed);
    if (hv == HASH_EMPTY || hv == HASH_TOMB) continue;
    uint64_t off = s.idx[i].off.load(std::memory_order_relaxed);
    if (off >= h->dataBytes) continue;
    Entry *e = s.entryAt(off);
    if (s.hints[i].load(std::memory_order_relaxed)) {    // second chance
      s.hints[i].store(0, std::memory_order_relaxed); continue; }
    if (slabClassFor(h, e->blockSize) != cls) continue;  // wrong class, no help
    unlinkSlot(s, i);
    return true;
  }
  return false;
}

static inline int64_t slabAlloc(Store &s, uint32_t need) {
  Header *h = s.h;
  int cls = slabClassFor(h, need);
  if (cls < 0) return -1;                       // larger than the biggest class
  uint32_t bsz = h->classSize[cls];
  for (int attempt = 0; attempt < 2; attempt++) {
    if (h->freeHead[cls]) {
      uint64_t off = h->freeHead[cls] - 1;
      Entry *e = s.entryAt(off);
      h->freeHead[cls] = *(uint64_t *)((uint8_t *)e + sizeof(std::atomic<uint32_t>));
      return (int64_t)off;
    }
    if (h->bumpPtr + bsz <= h->dataBytes) {
      uint64_t off = h->bumpPtr;
      h->bumpPtr += bsz;
      h->allocBytes += bsz;
      return (int64_t)off;
    }
    if (!slabEvictForClass(s, cls)) return -1;
  }
  return -1;
}

// ----------------------------------------------------------------- log ----
static const uint32_t SLOT_PAD = 0xFFFFFFFFu;

// Advance the tail past one record.
// In MODE_LOG2, a live entry that is protected (by quota, or by its reference
// bit) is re-appended at the head
// instead of dropped (its bit is cleared), giving the log CLOCK-style second
// chance. `budget` caps re-appends so a hot arena still makes progress.
static inline void logDropTail(Store &s, int *budget) {
  Header *h = s.h;
  h->tailAdvances++;
  uint64_t tailPos = h->logTail;
  uint64_t phys = tailPos & (h->dataBytes - 1);
  Entry *e = s.entryAt(tailPos);
  uint32_t bsz = e->blockSize;
  if (bsz == 0 || bsz > h->dataBytes) { h->logTail = h->logHead;
    h->tailPub.store(h->logTail, std::memory_order_release); return; }  // corrupt guard
  if (e->slot != SLOT_PAD) {
    uint64_t slot = e->slot;
    bool liveHere = slot < h->indexSlots &&
        s.idx[slot].off.load(std::memory_order_relaxed) == tailPos &&
        s.idx[slot].hash.load(std::memory_order_relaxed) == e->hash;
    if (liveHere) h->tailLive++;
    // Quota decides first, reference bit second. A namespace with a quota is
    // protected while it is under it and dropped once over, so a hot namespace
    // can no longer evict a cold one. A namespace without a quota keeps the
    // plain CLOCK behaviour and competes freely.
    bool protect;
    if (liveHere && h->nsQuota[e->ns]) {
      protect = h->nsBytes[e->ns] <= h->nsQuota[e->ns];
      if (protect) h->nsProtected[e->ns]++;
    } else {
      protect = liveHere && s.hints[slot].load(std::memory_order_relaxed);
    }
    if (liveHere && h->mode == MODE_LOG2 && protect && budget && *budget > 0) {
      uint64_t newPos = h->logHead;
      uint64_t hp = newPos & (h->dataBytes - 1);
      uint64_t freeBytes = h->dataBytes - (h->logHead - h->logTail);
      // Room must be verified BEFORE writing. This branch only runs while the
      // log is under allocation pressure - precisely when free space is scarce -
      // so writing bsz bytes at the head unchecked overwrites live records near
      // the tail whose index slots still point at them. That is a silent
      // data-corruption bug, not merely a lost entry.
      // ZERO-COPY SECOND CHANCE. This branch runs from the eviction loop, so
      // free space is short by definition - which is why the copying path was
      // firing on only 1.4% of live tail entries and second chance was
      // effectively dead in a full log, exactly when eviction matters.
      //
      // When the log is full the head lands on the tail's own bytes
      // (hp == phys). The record does not need to move at all: positions are
      // monotonic, so re-publishing it at the new position and advancing both
      // pointers gives it another lap for free. No memcpy, no room required.
      if (hp == phys && bsz <= h->dataBytes) {
        (*budget)--; h->reappends++;
        s.hints[slot].store(0, std::memory_order_relaxed);   // chance consumed
        s.idx[slot].off.store(newPos, std::memory_order_release);
        h->logHead += bsz;
        h->logTail += bsz;
        h->tailPub.store(h->logTail, std::memory_order_release);
        return;
      }
      if (freeBytes < bsz) h->reappendSkippedNoRoom++;
      if (freeBytes >= bsz && hp + bsz <= h->dataBytes && hp != phys) {
        (*budget)--; h->reappends++;
        Entry *dst = s.entryAt(hp);
        uint32_t dseq = dst->seq.load(std::memory_order_relaxed);
        dst->seq.store(dseq | 1, std::memory_order_release);
        std::atomic_thread_fence(std::memory_order_release);
        memcpy((uint8_t *)dst + 8, (uint8_t *)e + 8, bsz - 8);  // everything after seq+slot
        dst->slot = slot;
        s.hints[slot].store(0, std::memory_order_relaxed);      // second chance consumed
        std::atomic_thread_fence(std::memory_order_release);
        dst->seq.store((dseq | 1) + 1, std::memory_order_release);
        s.idx[slot].off.store(newPos, std::memory_order_release);
        h->logHead += bsz;
        h->logTail += bsz;
        h->tailPub.store(h->logTail, std::memory_order_release);
        return;
      }
    }
    if (liveHere) {
      indexRemove(s, slot);
      h->live--; h->liveBytes -= bsz; h->nsBytes[e->ns] -= bsz;
      h->evictions++; h->dropped++; h->nsDropped[e->ns]++;
    }
  }
  h->logTail += bsz;
  h->tailPub.store(h->logTail, std::memory_order_release);
}

static inline int64_t logAlloc(Store &s, uint32_t need) {
  Header *h = s.h;
  need = (uint32_t)align8(need);
  if (need > h->dataBytes / 2) return -1;
  int budget = g_secondChanceBudget;   // bounded second-chance re-appends per allocation
  uint64_t mask = h->dataBytes - 1;

  // The head position must be recomputed on every iteration: in MODE_LOG2 a
  // second-chance re-append advances logHead, invalidating any position we
  // captured before the eviction loop ran.
  for (uint64_t guard = 0; guard < 1u << 22; guard++) {
    uint64_t phys = h->logHead & mask;
    uint64_t freeBytes = h->dataBytes - (h->logHead - h->logTail);

    if (phys + need > h->dataBytes) {          // would straddle the wrap: pad to the end
      uint32_t pad = (uint32_t)(h->dataBytes - phys);
      if (freeBytes < pad) { logDropTail(s, &budget); continue; }
      Entry *p = s.entryAt(phys);
      uint32_t pseq = p->seq.load(std::memory_order_relaxed);
      p->seq.store(pseq | 1, std::memory_order_release);
      p->slot = SLOT_PAD; p->blockSize = pad; p->keyLen = 0; p->hash = 0;
      p->storedLen = 0; p->rawLen = 0;
      p->seq.store((pseq | 1) + 1, std::memory_order_release);
      h->logHead += pad;
      continue;
    }
    if (freeBytes < need) { logDropTail(s, &budget); continue; }

    uint64_t pos = h->logHead;
    h->logHead += need;
    h->allocBytes += need;
    return (int64_t)pos;
  }
  return -1;
}

// --------------------------------------------------------- compaction ----
// Background compression is value-preserving: it must NOT bump the entry
// version and must NOT append to the invalidation ring, or every compaction
// would needlessly flush worker L1s for data that did not change.
//
// Only the LZ4 call runs off-thread. Capture and apply both run on the single
// writer thread, so the only exposure is the window between them - closed by
// re-checking (slot, offset, hash, version) before publishing.

struct CompactItem {
  uint32_t slot;
  uint64_t off, hash;
  uint32_t version, rawLen, oldBlockSize;
  uint16_t keyLen;
  uint8_t  key[256];
  uint8_t *raw = nullptr, *comp = nullptr;
  uint32_t compLen = 0;
  bool     applied = false, stale = false, noGain = false;
};

// Is this capture still describing the entry we sampled?
static inline bool compactStillValid(Store &s, const CompactItem &it) {
  Header *h = s.h;
  if (it.off >= h->dataBytes) return false;
  if (s.idx[it.slot].hash.load(std::memory_order_acquire) != it.hash) return false;
  if (s.idx[it.slot].off.load(std::memory_order_acquire) != it.off) return false;
  Entry *e = s.entryAt(it.off);
  return e->version == it.version;      // globally monotonic: never reused
}

// Publish the compressed form as a fresh record at the head, repointing the
// index slot. The old block is left behind; the tail walker skips it because
// idx[slot].off no longer matches.
static inline void compactApply(Store &s, CompactItem &it) {
  Header *h = s.h;
  if (!compactStillValid(s, it)) { it.stale = true; return; }

  uint32_t need = (uint32_t)align8(sizeof(Entry) + it.keyLen + it.compLen);
  if (need >= it.oldBlockSize) { it.noGain = true; return; }

  Entry *src = s.entryAt(it.off);
  uint32_t expiresAt = src->expiresAt;
  uint8_t  hint      = s.hints[it.slot].load(std::memory_order_relaxed);
  uint8_t  srcNs     = src->ns; (void)srcNs;

  int64_t off2 = logAlloc(s, need);     // may evict - possibly our own source
  if (off2 < 0) { it.stale = true; return; }

  Entry *d = s.entryAt((uint64_t)off2);
  uint32_t dseq = d->seq.load(std::memory_order_relaxed);
  d->seq.store(dseq | 1, std::memory_order_release);
  std::atomic_thread_fence(std::memory_order_release);
  d->slot = it.slot; d->hash = it.hash;
  d->version = it.version;              // deliberately unchanged
  d->expiresAt = expiresAt; d->rawLen = it.rawLen; d->storedLen = it.compLen;
  d->blockSize = need; d->keyLen = it.keyLen;
  d->flags = FLAG_STRING | FLAG_LATIN1 | FLAG_COMPRESSED;
  d->ns = src->ns; s.hints[it.slot].store(hint, std::memory_order_relaxed);
  memcpy(s.keyOf(d), it.key, it.keyLen);
  memcpy(s.valOf(d), it.comp, it.compLen);
  std::atomic_thread_fence(std::memory_order_release);
  d->seq.store((dseq | 1) + 1, std::memory_order_release);

  // Re-check AFTER the allocation: logAlloc may have evicted the source.
  if (!compactStillValid(s, it)) {
    d->slot = SLOT_PAD;                 // leave a skippable hole for the tail walk
    it.stale = true;
    return;
  }
  s.idx[it.slot].off.store((uint64_t)off2, std::memory_order_release);
  h->liveBytes -= it.oldBlockSize;
  h->liveBytes += need;
  it.applied = true;
}

// ----------------------------------------------------------------- ops ----
static inline void ringAppend(Store &s, uint64_t hash, uint32_t version, uint16_t writerId) {
  Header *h = s.h;
  uint64_t pos = h->ringHead.fetch_add(1, std::memory_order_acq_rel);
  RingRec *r = &s.ring[pos & (h->ringCap - 1)];
  r->hash = hash; r->version = version; r->writerId = writerId;
}

// Sole-writer path. Returns false if the value could not be allocated.
static inline bool storeSet(Store &s, const uint8_t *key, uint16_t keyLen,
                            const uint8_t *val, uint32_t storedLen, uint32_t rawLen,
                            uint8_t flags, uint32_t expiresAt, uint16_t writerId,
                            uint8_t ns = 0) {
  Header *h = s.h;
  uint64_t hash = rapidhash(key, keyLen, 0);
  if (hash <= HASH_TOMB) hash += 2;   // reserve 0/1 as sentinels

  int64_t existing = s.findSlot(hash, key, keyLen);
  if (existing >= 0) unlinkSlot(s, (uint64_t)existing);

  // Keep the index below its load ceiling, so it can never saturate before the
  // data region does. Previously this silently failed inserts.
  if (h->mode != MODE_SLAB) {
    for (int guard = 0; h->live >= h->maxLive && guard < 4096; guard++) {
      uint64_t before = h->live;
      logDropTail(s, nullptr);                 // null budget: drop, never re-append
      h->indexEvictions++;
      if (h->live == before && h->logTail >= h->logHead) break;
    }
  }

  uint32_t need = (uint32_t)align8(sizeof(Entry) + keyLen + storedLen);
  int64_t off = (h->mode == MODE_SLAB) ? slabAlloc(s, need) : logAlloc(s, need);
  if (off < 0) return false;

  int64_t slot = s.findFreeSlot(hash);
  if (slot < 0) return false;

  Entry *e = s.entryAt((uint64_t)off);
  uint32_t seq = e->seq.load(std::memory_order_relaxed);
  e->seq.store(seq | 1, std::memory_order_release);       // mark unstable
  std::atomic_thread_fence(std::memory_order_release);

  e->slot = (uint32_t)slot; e->hash = hash; e->version = ++h->inserts;
  e->expiresAt = expiresAt; e->rawLen = rawLen; e->storedLen = storedLen;
  e->blockSize = (h->mode == MODE_SLAB) ? h->classSize[slabClassFor(h, need)] : (uint32_t)align8(need);
  e->keyLen = keyLen; e->flags = flags; e->ns = ns;
  memcpy(s.keyOf(e), key, keyLen);
  memcpy(s.valOf(e), val, storedLen);

  std::atomic_thread_fence(std::memory_order_release);
  e->seq.store((seq | 1) + 1, std::memory_order_release); // stable again

  s.idx[slot].off.store((uint64_t)off, std::memory_order_release);
  s.idx[slot].hash.store(hash, std::memory_order_release);
  s.hints[slot].store(1, std::memory_order_relaxed);   // a fresh entry gets one chance
  h->live++; h->liveBytes += e->blockSize; h->nsBytes[e->ns] += e->blockSize;
  ringAppend(s, hash, e->version, writerId);
  return true;
}

// Remove a key. Sole-writer path, like storeSet.
static inline bool storeDelete(Store &s, const uint8_t *key, uint16_t keyLen, uint16_t writerId) {
  Header *h = s.h;
  uint64_t hash = rapidhash(key, keyLen, 0);
  if (hash <= HASH_TOMB) hash += 2;
  int64_t slot = s.findSlot(hash, key, keyLen);
  if (slot < 0) return false;
  unlinkSlot(s, (uint64_t)slot);
  ringAppend(s, hash, ++h->inserts, writerId);
  return true;
}

// Drop everything. The log is NOT rewound: logTail is advanced to logHead so
// every previously published position becomes stale under the 
// liveness rule. Rewinding to zero would move the tail BACKWARDS and let a
// reader trust a stale position pointing at reused bytes.
// Drop every entry of one namespace. O(index slots); clearing is rare.
static inline uint64_t storeClearNamespace(Store &s, uint8_t ns, uint16_t writerId) {
  Header *h = s.h;
  uint64_t removed = 0;
  for (uint64_t i = 0; i < h->indexSlots; i++) {
    uint64_t hv = s.idx[i].hash.load(std::memory_order_relaxed);
    if (hv == HASH_EMPTY || hv == HASH_TOMB) continue;
    uint64_t pos = s.idx[i].off.load(std::memory_order_relaxed);
    Entry *e = s.entryAt(pos);
    if (e->ns != ns) continue;
    uint32_t bsz = e->blockSize;
    indexRemove(s, i);
    h->live--; h->liveBytes -= bsz; h->nsBytes[ns] -= bsz; h->evictions++;
    removed++;
    i--;                       // backward-shift may have moved an entry into i
  }
  ringAppend(s, RING_FLUSH_ALL, ++h->inserts, writerId);
  return removed;
}

static inline void storeClear(Store &s, uint16_t writerId) {
  Header *h = s.h;
  memset(s.idx, 0, h->indexSlots * sizeof(IndexSlot));
  if (s.hints) for (uint64_t i = 0; i < h->indexSlots; i++) s.hints[i].store(0, std::memory_order_relaxed);
  h->logTail = h->logHead;
  h->tailPub.store(h->logTail, std::memory_order_release);
  h->live = 0; h->liveBytes = 0;
  for (int i = 0; i < NS_MAX; i++) h->nsBytes[i] = 0;
  for (int i = 0; i < NCLASS; i++) h->freeHead[i] = 0;
  h->bumpPtr = 0;
  ringAppend(s, RING_FLUSH_ALL, ++h->inserts, writerId);   // tells workers to drop L1
}

// Existence check: index probe plus key compare plus expiry, with no value copy
// and no promotion. Deliberately does not touch the CLOCK reference bit.
static inline bool storeHas(Store &s, const uint8_t *key, uint16_t keyLen, uint32_t nowSec) {
  Header *h = s.h;
  uint64_t hash = rapidhash(key, keyLen, 0);
  if (hash <= HASH_TOMB) hash += 2;
  int64_t slot = s.findSlot(hash, key, keyLen);
  if (slot < 0) return false;
  uint64_t pos = s.idx[slot].off.load(std::memory_order_acquire);
  Entry *e = s.entryAt(pos);
  uint32_t exp = e->expiresAt;
  if (h->mode != MODE_SLAB && h->tailPub.load(std::memory_order_seq_cst) > pos) return false;
  return !(exp && exp <= nowSec);
}

// Reader path. Safe against a concurrent writer reusing the block underneath us:
// copy first, then re-check the sequence, and discard a torn read.
static inline bool storeGet(Store &s, const uint8_t *key, uint16_t keyLen,
                            uint8_t *scratch, size_t scratchCap, ReadResult *out,
                            uint32_t nowSec) {
  Header *h = s.h;
  uint64_t hash = rapidhash(key, keyLen, 0);
  if (hash <= HASH_TOMB) hash += 2;
  uint64_t mask = h->indexSlots - 1;
  uint64_t i = hash & mask;

  for (uint64_t probes = 0; probes <= mask; probes++, i = (i + 1) & mask) {
    uint64_t hv = s.idx[i].hash.load(std::memory_order_acquire);
    if (hv == HASH_EMPTY) return false;
    if (hv != hash) continue;
    uint64_t pos = s.idx[i].off.load(std::memory_order_acquire);
    Entry *e = s.entryAt(pos);

    for (int retry = 0; retry < 8; retry++) {
      uint32_t s1 = e->seq.load(std::memory_order_acquire);
      if (s1 & 1) continue;                                  // writer mid-update
      uint16_t kl = e->keyLen; uint32_t sl = e->storedLen, rl = e->rawLen;
      uint8_t fl = e->flags; uint32_t exp = e->expiresAt; uint64_t eh = e->hash;
      // Defensive: a torn or corrupt length must never drive a memcpy.
      uint64_t phys = pos & (h->dataBytes - 1);
      if ((uint64_t)sizeof(Entry) + kl + sl > h->dataBytes - phys) continue;
      if (sl > scratchCap || kl != keyLen) break;
      if (memcmp(s.keyOf(e), key, keyLen) != 0) break;
      memcpy(scratch, s.valOf(e), sl);
      std::atomic_thread_fence(std::memory_order_acquire);
      uint32_t s2 = e->seq.load(std::memory_order_acquire);
      if (s1 != s2 || eh != hash) continue;                  // torn - retry

      // The seqlock alone is NOT sufficient. It protects an in-place rewrite of
      // this entry, but if the entry was evicted and the log head wrapped over
      // its bytes, this address is no longer an Entry header at all - e->seq is
      // then somebody else's payload, which can read as stable and even twice in
      // a row. Because the same keys are rewritten repeatedly, those bytes
      // frequently hold an OLDER copy of the same key, so memcmp passes too.
      //
      // The log position is monotonic and never reused, so it CAN prove
      // liveness: the bytes at `pos` still belong to record `pos` exactly while
      // logTail <= pos. Loading the published tail after the copy therefore
      // proves the record was live for the whole copy (tail only increases).
      // seq_cst so the copy cannot be reordered after this load.
      if (h->mode != MODE_SLAB && h->tailPub.load(std::memory_order_seq_cst) > pos) return false;
      if (exp && exp <= nowSec) return false;                // lazily expired
      // Reference bit lives in the hints region, which workers map READ-WRITE
      // even though the rest of the segment is read-only to them. Load first:
      // a hot entry is already marked, so the store (and the cache-line
      // ping-pong between workers) is skipped.
      if (s.hints && !g_suppressRefBit && !s.hints[i].load(std::memory_order_relaxed))
        s.hints[i].store(1, std::memory_order_relaxed);
      out->hit = true; out->rawLen = rl; out->storedLen = sl;
      out->flags = fl; out->buf = scratch;
      return true;
    }
    return false;
  }
  return false;
}
