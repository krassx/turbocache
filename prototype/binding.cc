#define NAPI_VERSION 10
#include <node_api.h>
#include <lz4.h>
#include <stdlib.h>
#include <time.h>
#include "store_ops.h"
#include <vector>
#include <unistd.h>

static Store g;
static uint8_t *scratch = nullptr;
static const size_t SCRATCH = 4u << 20;
static uint8_t *cbuf = nullptr;
static uint32_t compressMin = 256;
static int compressAccel = 1;   // LZ4 acceleration: higher = faster, worse ratio

static uint32_t nowSec() { return (uint32_t)time(nullptr); }

#define ARG(n) napi_value argv[n]; size_t argc = n; \
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

static napi_value Create(napi_env env, napi_callback_info info) {
  ARG(4)
  char nm[64]; size_t l;
  napi_get_value_string_latin1(env, argv[0], nm, sizeof(nm), &l);
  int64_t total, slots; int32_t mode;
  napi_get_value_int64(env, argv[1], &total);
  napi_get_value_int64(env, argv[2], &slots);
  napi_get_value_int32(env, argv[3], &mode);
  if (!scratch) { scratch = (uint8_t *)malloc(SCRATCH); cbuf = (uint8_t *)malloc(SCRATCH); }
  bool ok = g.create(nm, (uint64_t)total, (uint64_t)slots, (uint8_t)mode);
  napi_value r; napi_get_boolean(env, ok, &r); return r;
}

static napi_value Attach(napi_env env, napi_callback_info info) {
  ARG(1)
  char nm[64]; size_t l;
  napi_get_value_string_latin1(env, argv[0], nm, sizeof(nm), &l);
  if (!scratch) { scratch = (uint8_t *)malloc(SCRATCH); cbuf = (uint8_t *)malloc(SCRATCH); }
  bool ok = g.attachReadOnly(nm);
  napi_value r; napi_get_boolean(env, ok, &r); return r;
}

static napi_value SetCompressMin(napi_env env, napi_callback_info info) {
  ARG(2) int32_t v; napi_get_value_int32(env, argv[0], &v); compressMin = (uint32_t)v;
  int32_t a = 0; if (argc > 1 && napi_get_value_int32(env, argv[1], &a) == napi_ok && a > 0) compressAccel = a;
  return nullptr;
}

// set(key, value) - value is a latin1 string in this prototype
static napi_value Set(napi_env env, napi_callback_info info) {
  ARG(2)
  char key[512]; size_t klen = 0;
  napi_get_value_string_latin1(env, argv[0], key, sizeof(key), &klen);
  size_t vlen = 0;
  napi_get_value_string_latin1(env, argv[1], nullptr, 0, &vlen);
  if (vlen + 1 > SCRATCH) { napi_value r; napi_get_boolean(env, false, &r); return r; }
  size_t got = 0;
  napi_get_value_string_latin1(env, argv[1], (char *)scratch, SCRATCH, &got);

  const uint8_t *payload = scratch;
  uint32_t storedLen = (uint32_t)vlen, rawLen = (uint32_t)vlen;
  uint8_t flags = FLAG_STRING | FLAG_LATIN1;
  if (vlen >= compressMin) {
    int c = LZ4_compress_fast((const char *)scratch, (char *)cbuf, (int)vlen, (int)SCRATCH, compressAccel);
    if (c > 0 && (uint32_t)c < rawLen - (rawLen >> 3)) {   // keep only if >12.5% smaller
      payload = cbuf; storedLen = (uint32_t)c; flags |= FLAG_COMPRESSED;
    }
  }
  bool ok = storeSet(g, (const uint8_t *)key, (uint16_t)klen, payload, storedLen, rawLen, flags, 0, 0);
  napi_value r; napi_get_boolean(env, ok, &r); return r;
}

// get(key) -> string | undefined  (full path incl. decompress + V8 string build)
static napi_value Get(napi_env env, napi_callback_info info) {
  ARG(1)
  char key[512]; size_t klen = 0;
  napi_get_value_string_latin1(env, argv[0], key, sizeof(key), &klen);
  ReadResult rr;
  if (!storeGet(g, (const uint8_t *)key, (uint16_t)klen, scratch, SCRATCH, &rr, nowSec()))
    return nullptr;
  const char *src = (const char *)rr.buf;
  if (rr.flags & FLAG_COMPRESSED) {
    int d = LZ4_decompress_safe((const char *)rr.buf, (char *)cbuf, (int)rr.storedLen, (int)SCRATCH);
    if (d < 0) return nullptr;
    src = (const char *)cbuf;
  }
  napi_value out;
  napi_create_string_latin1(env, src, rr.rawLen, &out);
  return out;
}

// getLen(key) -> int  (arena lookup + decompress, no V8 string construction)
static napi_value GetLen(napi_env env, napi_callback_info info) {
  ARG(1)
  char key[512]; size_t klen = 0;
  napi_get_value_string_latin1(env, argv[0], key, sizeof(key), &klen);
  ReadResult rr;
  int32_t n = -1;
  if (storeGet(g, (const uint8_t *)key, (uint16_t)klen, scratch, SCRATCH, &rr, nowSec())) {
    if (rr.flags & FLAG_COMPRESSED)
      LZ4_decompress_safe((const char *)rr.buf, (char *)cbuf, (int)rr.storedLen, (int)SCRATCH);
    n = (int32_t)rr.rawLen;
  }
  napi_value out; napi_create_int32(env, n, &out); return out;
}

// probe(key) -> int  (index probe + memcmp only; no value copy, no decompress)
static napi_value Probe(napi_env env, napi_callback_info info) {
  ARG(1)
  char key[512]; size_t klen = 0;
  napi_get_value_string_latin1(env, argv[0], key, sizeof(key), &klen);
  uint64_t hash = rapidhash(key, klen, 0);
  if (hash <= HASH_TOMB) hash += 2;
  int64_t slot = g.findSlot(hash, (const uint8_t *)key, (uint16_t)klen);
  napi_value out; napi_create_int32(env, (int32_t)slot, &out); return out;
}

static void put(napi_env env, napi_value o, const char *k, double v) {
  napi_value n; napi_create_double(env, v, &n); napi_set_named_property(env, o, k, n);
}

// -------------------------------------------------- background compaction ----
static uint64_t cApplied = 0, cStale = 0, cNoGain = 0, cScanned = 0;
static int64_t  cReclaimed = 0;

struct Job {
  napi_async_work work = nullptr;
  napi_ref cbRef = nullptr;
  std::vector<CompactItem> items;
  uint32_t delayUs = 0;
  uint32_t applied = 0, stale = 0, noGain = 0;
  int64_t  reclaimed = 0;
};

// Runs on the libuv threadpool. Touches ONLY the private capture buffers -
// never the arena, never napi. This is the whole point: the expensive part is
// off the writer thread, and it cannot observe or mutate shared state.
static void CompactExecute(napi_env, void *data) {
  Job *j = (Job *)data;
  if (j->delayUs) usleep(j->delayUs);   // test hook: widen the capture->apply window
  for (auto &it : j->items) {
    int c = LZ4_compress_default((const char *)it.raw, (char *)it.comp,
                                 (int)it.rawLen, (int)LZ4_compressBound(it.rawLen));
    it.compLen = c > 0 ? (uint32_t)c : 0;
  }
}

// Back on the writer thread. Nothing else can be mutating the arena here, so
// validate-then-publish needs no lock - only the version re-check.
static void CompactComplete(napi_env env, napi_status, void *data) {
  Job *j = (Job *)data;
  for (auto &it : j->items) {
    if (it.compLen == 0) { it.noGain = true; }
    else compactApply(g, it);
    if (it.applied) {
      j->applied++;
      j->reclaimed += (int64_t)it.oldBlockSize - (int64_t)align8(sizeof(Entry) + it.keyLen + it.compLen);
    } else if (it.stale) j->stale++;
    else j->noGain++;
    free(it.raw); free(it.comp);
  }
  cApplied += j->applied; cStale += j->stale; cNoGain += j->noGain; cReclaimed += j->reclaimed;

  napi_value cb, undef, arg;
  napi_get_reference_value(env, j->cbRef, &cb);
  napi_get_undefined(env, &undef);
  napi_create_object(env, &arg);
  put(env, arg, "applied", j->applied);
  put(env, arg, "stale", j->stale);
  put(env, arg, "noGain", j->noGain);
  put(env, arg, "reclaimed", (double)j->reclaimed);
  napi_call_function(env, undef, cb, 1, &arg, nullptr);
  napi_delete_reference(env, j->cbRef);
  napi_delete_async_work(env, j->work);
  delete j;
}

// compactAsync(maxItems, minBytes, delayUs, coldOnly, cb)
static napi_value CompactAsync(napi_env env, napi_callback_info info) {
  ARG(5)
  int32_t maxItems, minBytes, delayUs; bool coldOnly = false;
  napi_get_value_int32(env, argv[0], &maxItems);
  napi_get_value_int32(env, argv[1], &minBytes);
  napi_get_value_int32(env, argv[2], &delayUs);
  napi_get_value_bool(env, argv[3], &coldOnly);

  Job *j = new Job();
  j->delayUs = (uint32_t)delayUs;
  napi_create_reference(env, argv[4], 1, &j->cbRef);

  // Capture candidates walking forward from the tail - the entries the log is
  // about to reach. Compressing these turns "second chance at full size" into
  // "second chance at compressed size".
  Header *h = g.h;
  uint64_t cur = h->logTail;
  int scanned = 0;
  while (cur < h->logHead && (int)j->items.size() < maxItems && scanned < maxItems * 8) {
    uint64_t phys = cur & (h->dataBytes - 1);
    Entry *e = g.entryAt(phys);
    uint32_t bsz = e->blockSize;
    if (bsz == 0 || bsz > h->dataBytes) break;
    cur += bsz; scanned++;
    if (e->slot == SLOT_PAD) continue;
    if (e->flags & FLAG_COMPRESSED) continue;
    if (e->rawLen < (uint32_t)minBytes) continue;
    // Compressing a hot entry taxes every future read of it. Only compress
    // entries that have not been touched since their last second chance -
    // the ones about to be evicted anyway.
    if (coldOnly && e->refBit) continue;
    if (e->keyLen > 256) continue;
    uint32_t slot = e->slot;
    if (slot >= h->indexSlots) continue;
    if (g.idx[slot].off.load(std::memory_order_relaxed) != phys) continue;   // not live here
    if (g.idx[slot].hash.load(std::memory_order_relaxed) != e->hash) continue;

    CompactItem it;
    it.slot = slot; it.off = phys; it.hash = e->hash; it.version = e->version;
    it.rawLen = e->rawLen; it.oldBlockSize = bsz; it.keyLen = e->keyLen;
    memcpy(it.key, g.keyOf(e), e->keyLen);
    it.raw = (uint8_t *)malloc(it.rawLen);
    it.comp = (uint8_t *)malloc(LZ4_compressBound(it.rawLen));
    memcpy(it.raw, g.valOf(e), it.rawLen);     // storedLen == rawLen: uncompressed
    j->items.push_back(it);
  }
  cScanned += scanned;

  napi_value name; napi_create_string_latin1(env, "compact", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, CompactExecute, CompactComplete, j, &j->work);
  napi_queue_async_work(env, j->work);
  napi_value out; napi_create_int32(env, (int32_t)j->items.size(), &out); return out;
}

static napi_value ClearHints(napi_env env, napi_callback_info) {
  memset(g.hints, 0, g.h->hintsBytes); return nullptr;
}
static napi_value HintsSet(napi_env env, napi_callback_info) {
  uint64_t n = 0;
  for (uint64_t i = 0; i < g.h->indexSlots; i++) if (g.hints[i]) n++;
  napi_value r; napi_create_double(env, (double)n, &r); return r;
}
static napi_value SetBackwardShift(napi_env env, napi_callback_info info) {
  ARG(1) bool v; napi_get_value_bool(env, argv[0], &v); g_backwardShift = v; return nullptr;
}
static napi_value SetSuppressRefBit(napi_env env, napi_callback_info info) {
  ARG(1) bool v; napi_get_value_bool(env, argv[0], &v); g_suppressRefBit = v; return nullptr;
}

// missProbe(key) -> probe cost for a key that is NOT present
static napi_value CompactStats(napi_env env, napi_callback_info) {
  napi_value o; napi_create_object(env, &o);
  put(env, o, "applied", (double)cApplied);
  put(env, o, "stale", (double)cStale);
  put(env, o, "noGain", (double)cNoGain);
  put(env, o, "scanned", (double)cScanned);
  put(env, o, "reclaimed", (double)cReclaimed);
  return o;
}

// Deliberately writes through the mapping, to prove a read-only worker faults.
static napi_value Poke(napi_env env, napi_callback_info) {
  volatile uint8_t *p = (volatile uint8_t *)g.base + g.h->dataOff;
  *p = 0x42;
  napi_value r; napi_get_boolean(env, true, &r); return r;
}

static napi_value Stats(napi_env env, napi_callback_info) {
  napi_value o; napi_create_object(env, &o);
  Header *h = g.h;
  put(env, o, "mode", h->mode);
  put(env, o, "live", (double)h->live);
  put(env, o, "inserts", (double)h->inserts);
  put(env, o, "evictions", (double)h->evictions);
  put(env, o, "liveBytes", (double)h->liveBytes);
  put(env, o, "dataBytes", (double)h->dataBytes);
  put(env, o, "bumpPtr", (double)h->bumpPtr);
  put(env, o, "logHead", (double)h->logHead);
  put(env, o, "logTail", (double)h->logTail);
  put(env, o, "indexSlots", (double)h->indexSlots);
  put(env, o, "ringHead", (double)h->ringHead.load());
  return o;
}
static napi_value Destroy(napi_env env, napi_callback_info) { g.destroy(); return nullptr; }

#define FN(name, fn) { napi_value f; napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &f); \
                       napi_set_named_property(env, exports, name, f); }
static napi_value Init(napi_env env, napi_value exports) {
  FN("create", Create) FN("attach", Attach) FN("set", Set) FN("get", Get)
  FN("getLen", GetLen) FN("probe", Probe) FN("stats", Stats)
  FN("destroy", Destroy) FN("poke", Poke)
  FN("suppressRefBit", SetSuppressRefBit) FN("backwardShift", SetBackwardShift) FN("clearHints", ClearHints) FN("hintsSet", HintsSet) FN("compactAsync", CompactAsync) FN("compactStats", CompactStats) FN("setCompressMin", SetCompressMin)
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
