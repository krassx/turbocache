# turbocache — Design

> Status: **draft, pre-implementation**. Nothing in this repo is built yet.
> All performance numbers were measured on the target machine (Apple Silicon, Node 24.15.0, V8 13.6.233) — see [Measurements](#measurements).

---

## 1. Understanding

**What.** A layered in-memory key/value cache for Node.js services running under `node:cluster`. Two tiers: **L1**, private to each worker; **L2**, owned by the primary process and exposed to workers as a read-only shared memory mapping. A future **L3** (Valkey/Redis) sits behind both.

**Why.** Existing options force a bad choice: per-worker caches (`lru-cache`) duplicate data N times with no coherence, and out-of-process stores (Redis over a socket) cost ~50–200µs per hit. The gap is a cache that is *shared* across workers but served at *memory* latency.

**Who.** Node services on multi-core hosts, caching values hot enough that decode cost matters.

**Non-goals for v1.** Persistence. Distribution. Arbitrary JS object values. Windows. Atomic read-modify-write. Async APIs.

---

## 2. Public API (v1)

```js
const { Cache } = require('turbocache');   // alias of TurboCache
const cluster = require('cluster');

// Primary, BEFORE forking. Sizes itself from the machine, names its own
// segment, and passes the name to workers through the environment.
const cache = Cache.open({ storage: 'primitives' });
Cache.install(cluster);          // the entire primary-side wiring

// Worker. Same call; it detects that it is a worker and attaches. Throws if the
// primary has not opened the arena yet: a worker must never create one, or it
// silently shadows the primary's.
const cache = Cache.open({ storage: 'primitives' });

// A second namespace in the same process binds to the arena already open.
const other = Cache.open({ namespace: { name: 'sessions', quotaBytes: 32 << 20 } });
```

```ts
class Cache {
  constructor(opts?: {
    storage?: 'bytes' | 'direct' | 'safe';        // default 'bytes'
    namespace?: string;        // prefixed into the key
    l1MaxBytes?: number;       // default: heapLimit x 0.5%, clamped 512KB..2MB
    arenaBytes?: number;       // default: totalRAM x 1%, clamped 16MB..128MB
    indexSlots?: number;       // default: derived from arenaBytes
    codec?: { encode, decode };// overrides the storage preset's codec
    freeze?: boolean;          // codec modes; default true
    heapGuard?: false | { maxHeapFraction?: number };
  });

  get(key: string): Value | undefined;
  set(key: string, value: Value, opts?: { ttlMs?: number }): boolean;
  has(key: string): boolean;
  delete(key: string): boolean;
  clearLocal(): void;          // this process's L1 only
  clearAll(): void;            // the shared arena AND every worker's L1
  clearNamespace(): void;      // just this cache's namespace
  close(): void;

  incr(key: string, by?: number, opts?: { ttlMs?: number }): number | undefined | false;
  cas(key: string, expected: number, next: number): boolean;   // primary only

  keys(opts?: { limit?, batch? }): Iterable<string>;   // this namespace
  readonly size: number;                               // live entries here

  readonly stats: { l1Hits, l2Hits, misses, sets, deletes, invalidated,
                    rejectedType, rejectedSize, flushes, sent };
  readonly lastError: string | null;

  static open(opts?): Cache;   // create (primary) or attach (worker)
  static install(cluster): void;
  static namespaceStats(): Array<{name, id, bytes, quota, protected, dropped}>;
  static arenaStats(): { live, evictions, liveBytes, dataBytes, ... };
  static primaryAgeMs(): number;   // ms since the primary last stamped the arena
}
```

Keys are UTF-8 and capped at **1024 bytes**; longer keys are rejected. They were
previously read into a fixed `char[512]` as latin1, so a 512-byte key was
truncated to its prefix and any character above U+00FF folded to its low byte —
distinct keys collided and returned *each other's values*.
```

Four API decisions worth stating, because each rejects a plausible alternative:

**`set` returns a boolean and never throws — for anything.** Not merely for
capacity: a codec that throws (JSON on a BigInt or a cycle) and a codec that
returns `undefined` rather than throwing (`JSON.stringify` of a function, a
symbol, or `undefined` itself) both surface as `false`. Because a total function
makes failure quiet, every rejection increments `stats.rejectedType` or
`stats.rejectedSize` and records `lastError`.

**`set` reports acceptance, not durability.** `true` means the value was
accepted, successfully serialised and queued — not that it is in L2 yet, since a
worker's write is applied by the primary about a tick later. That distinction
forces the size check to happen at the call site: a worker now compares against
the arena's maximum value size locally, because otherwise an oversized value
would be queued, silently dropped by the primary, and reported as success.

**There is no `clear()`.** `clearLocal()` drops this process's L1 and nothing
else; `clearAll()` wipes the shared arena and makes every worker drop its L1 via
a flush record on the invalidation ring. A single `clear()` would let any worker
wipe a shared cache for the whole cluster with a call that reads as local.

**`has` is a pure probe.** No decode, no promotion into L1, not counted as a hit,
and it does not set the CLOCK reference bit — so an existence check cannot
distort hit-rate statistics or eviction order. It matters more than it sounds:
because `null` is a storable value, `get(k) === undefined` is not an existence
check, and `has` is the only way to ask the question.

**`delete` reports presence at call time.** A worker's delete is applied a tick
later, so it answers "was this key here when you asked" — matching what the
primary returns. It previously returned an unconditional `true` in a worker, so
a worker and the primary disagreed about the same absent key.

**Enumeration exists.** `keys()` and `size` scan the index and read the stored
key text. Decision 3 named this as a benefit of verifying keys with `memcmp`,
but nothing ever exposed it, so there was no way to see what a cache held. It is
O(index slots) and meant for operations, not the hot path.

**Values may be binary.** `Buffer`, any `TypedArray`, `ArrayBuffer` and
`DataView` are accepted by `bytes` mode and stored as raw bytes. They come
back as a `Buffer` (a `Uint8Array` subclass, so `instanceof` still holds) and are
**copied on every read** — decision 7's rule for mutable values, applied on both
the L1 and the L2 refill path.

**`incr` and `cas` are atomic, because there is only one writer.** On the primary
`incr` returns the new value and `cas` returns whether it replaced. In a worker
the write is applied a tick later, so:

- `incr` **queues the delta** and returns `undefined`; read the value back with
  `get()`. Queuing a *delta* rather than a value is what makes it lossless —
  measured: 4 workers x 500 concurrent increments produce exactly 2000.
- `cas` **throws** in a worker. A queued compare-and-set whose outcome the caller
  never learns is not a compare-and-set, so it is primary-only rather than
  quietly returning a misleading `true`.

A missing key counts as zero. `incr` returns `false` if the key holds a
non-numeric value, matching `set`'s "accepted" contract.

**TTL is enforced in both tiers.** The arena expires lazily on read, but an L1
hit never reaches the arena, so L1 entries carry their own expiry. Without that,
an expired value is served from L1 indefinitely — which is exactly what the
first implementation did.

## 3. Architecture

```
┌─ primary process ────────────────────────────────────────────┐
│  L2 arena  (shm_open + mmap, READ/WRITE — sole writer)       │
│    ├── header (magic, layout ver, heartbeat, sizes)          │
│    ├── invalidation ring buffer                              │
│    ├── hash index (open addressing)                          │
│    ├── hints (separate shm segment, workers map it O_RDWR)   │
│    └── circular log + second-chance re-append (LOG2)         │
│  IPC receiver  ← batched writes from workers                 │
│  eviction on the write path (no background sweeper exists)   │
└──────────────────────────────────────────────────────────────┘
        ▲ writes (batched IPC)        │ mmap READ-ONLY
        │                             ▼
┌─ worker process ─────────────────────────────────────────────┐
│  L1: JS Map<string, Entry>          ~21 ns/hit               │
│      small values  → ordinary V8 strings                     │
│      large values  → external strings over off-heap arena    │
│  native addon (Node-API): rapidhash, LZ4, seqlock L2 reader  │
└──────────────────────────────────────────────────────────────┘
```

### Why the primary is the only writer

This is the load-bearing decision. A single writer means:

- **No cross-process locks.** No shared allocator under contention, no write-side seqlock, no CAS loops.
- **No robust-mutex problem.** macOS has no `PTHREAD_MUTEX_ROBUST`. With multiple writers, a `SIGKILL`ed worker holding a lock deadlocks the arena permanently, and there is no portable recovery. With one writer, that failure mode does not exist.
- **A worker physically cannot corrupt L2.** Its mapping has no write permission. Worker crashes are contained by the MMU, not by discipline.
- **The primary is off the read path**, so it is not a throughput bottleneck. It only absorbs writes, which are batched.

The cost is that `set()` reaches L2 asynchronously (next tick). For a cache, that is the right trade.

---

## 4. L1 — per-worker

L1 is a **JS `Map`**, not a native store. Measurements drove this:

| L1 strategy | hit, 200B | hit, 16KB | allocation per hit |
|---|---|---|---|
| **JS `Map`** | **~20 ns** | **~21 ns** | **none** |
| native, copy out | 30 ns | 439 ns | new V8 string every hit |
| native, external string per call | 58 ns | 59 ns | new external + finalizer every hit |

A native store must build a fresh V8 string on **every hit** — so it does not avoid GC pressure, it *manufactures* it. A `Map` returns the identical immutable string with zero allocation.

### Off-heap bytes without the per-hit cost

External strings (`node_api_create_external_string_latin1`) let V8 point directly at off-heap memory. Created *per call* they are slower than copying below ~1KB. Created **once at insert** and cached in the `Map`, they give ~21ns hits at every size *and* keep the bytes off the V8 heap.

So:

- value `< externMinBytes` (1KB) → ordinary V8 string, copied once at insert
- value `>= externMinBytes` → external string over a per-worker off-heap arena, created once at insert

Both are ~21ns to read thereafter.

**The catch: eviction becomes GC-gated.** The external string holds a raw pointer into the arena. Dropping the `Map` entry does not free the arena slot — the finalizer only runs when V8 collects the string, and a caller holding a long-lived reference pins those bytes indefinitely. The `l1Bytes` cap is therefore *soft* for the external tier.
**Mitigation:** track pinned bytes; when the arena is full and every slot is pinned, fall back to copied heap strings for new inserts until pressure drops. Degrades gracefully instead of stalling.

L1 keys are JS strings in a `Map` — V8 already hashes and caches those. **rapidhash is used for L2 only.**

Eviction is **CLOCK / sampled**, not strict LRU: strict LRU in a JS `Map` means `delete`+`set` on every hit (~50–80ns), which would triple hit cost. A per-entry counter bumped on read is ~1ns.

---

## 5. L2 — shared arena

Created by the primary before forking. `shm_open` (mode 0600) + `ftruncate` + `mmap`; workers reopen `O_RDONLY` and `mmap` with `PROT_READ`.

### Entry layout

```c
struct Entry {
  uint32_t seq;         // seqlock: even = stable, odd = write in progress
  uint64_t hash;        // rapidhash64(namespace + key)
  uint32_t version;     // bumped per write; matches invalidation ring
  uint32_t expiresAt;   // MILLISECONDS from the arena epoch; 0 = no TTL
  uint32_t rawLen;      // uncompressed length
  uint32_t storedLen;   // on-disk length (== rawLen if uncompressed)
  uint32_t blockSize;   // total bytes of this record, for the tail walk
  uint16_t keyLen;
  uint8_t  flags;       // COMPRESSED | STRING | LATIN1 | NUMBER | BOOL | NULL | BIGINT
  uint8_t  ns;          // namespace id (CLOCK bits live in the hints segment)
  // ... keyLen bytes of key text, then storedLen bytes of value
};  // 40-byte header
```

**Key text is stored.** It costs bytes, and it buys three things: exact `memcmp` verification (so a 64-bit hash is *exactly* correct, no collision risk, rather than probabilistic); key enumeration remains possible; and the future L3 can use real Redis keys instead of opaque hash hex.

`IS_LATIN1` matters: `napi_create_string_latin1` is materially cheaper than UTF-8 decoding, so latin1 values take a faster read path.

### Data region: circular log with second chance

Entries are appended at a monotonic head; eviction advances the tail. There is
**no free list and no fragmentation** — a variable-size record never has to fit
a fixed class, so the calcification that strands memory in a size-class
allocator cannot occur.

Plain FIFO eviction, though, is frequency-blind, which costs it real hit rate.
So when the tail reaches a live entry whose CLOCK reference bit is set, the
entry is **re-appended at the head** and its bit cleared, rather than dropped —
CLOCK's second chance, expressed on a log. Re-appends are capped (64 per
allocation, measured to saturate at 8) so a fully-hot arena still makes progress.

A record must not straddle the wrap point, so the tail of the buffer is filled
with a pad record when the next entry will not fit. Note that masking also
quantises capacity to powers of two — see open question 8. Note that in this mode a
re-append advances the head, so any write position must be recomputed *after*
the eviction loop, not before — getting this wrong silently corrupts entries,
and it is the one bug the prototype actually hit.

### Seqlock read (worker side)

```
do {
  s1 = load_acquire(e.seq);
  if (s1 & 1) continue;              // writer mid-update
  bounds-check keyLen/storedLen against arena size
  memcpy header + key + value into a local scratch buffer
  s2 = load_acquire(e.seq);
} while (s1 != s2);
memcmp(scratch.key, requestedKey)    // verify, then decompress
```

Copy-then-validate is required: a torn read must be discarded, not acted on. The bounds check is defensive — the primary is trusted, but a corrupt length would otherwise be an out-of-bounds read.

### Invalidation ring

Rather than `worker.send()` per write per worker (`O(writes × workers)` IPC messages), the ring lives **in the arena**:

```c
struct Ring { _Atomic uint64_t head; uint32_t capacity; Record records[]; };
struct Record { uint64_t hash; uint32_t version; uint16_t writerId; };
```

The primary appends on every write — `O(1)` regardless of worker count, zero IPC. Each worker keeps a private cursor and drains lazily at the top of each `get`/`set`: one relaxed load of `head`, a hot and usually-unchanged cache line. Records carry `writerId` so a worker skips invalidations caused by its own writes.

If `head - cursor > capacity` the ring has wrapped past that worker; it flushes its entire L1. Safe, self-correcting, and bounded.

---

## 6. Data flow

**`get(key)`**
1. Drain invalidation ring (one atomic load, usually a no-op).
2. `l1.get(key)` → hit: check TTL, bump CLOCK bit, return. **~21ns.**
3. Miss → native L2 probe: rapidhash64 → open-address probe → seqlock read → `memcmp` key → LZ4 decompress if flagged → build JS value → insert into L1 → return. **~150–400ns**, size-dependent.
4. Miss → `undefined`. (Future: fall through to L3, async only.)

**`set(key, value, {ttlMs})`**
1. *(Only if compression is explicitly enabled — it is **off by default**, see §9.)* Compress in the **worker** if `rawLen >= compressMinBytes` and LZ4 shrinks it by >12.5%.
2. Insert into L1, evicting to stay under budget.
3. Append to a per-tick outbox.
4. Flush the outbox to the primary on `setImmediate` — one IPC message per tick, `serialization: 'advanced'` so `Buffer`s cross without base64.
5. Return (synchronous).

Compressing in the worker distributes ~200–250ns of CPU across all workers instead of concentrating it in the primary, and shrinks the IPC payload. The primary then only `memcpy`s the already-compressed blob — this is the "propagate without recomputing" property, preserved exactly.

Batching means a `set` in worker A is visible to worker B after ~1 tick. **Documented, bounded staleness.**

---

## 7. Sizing

Computed once at startup, then fixed. A fixed mapping is the single biggest simplification available — growing L2 would mean remapping in every live worker mid-read.

| | formula | typical |
|---|---|---|
| L2 | `clamp(totalRAM × 1%, 16MB, 128MB)` | ~40MB on a 4GB host |
| L1 | `clamp(heapLimit × 0.5%, 512KB, 2MB)` | ~1–2MB |

Both overridable via constructor options.

---

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Worker `SIGKILL`ed | Arena untouched — worker had no write permission. Its unflushed outbox is lost. |
| Worker killed mid-read | Nothing held; no lock, no cleanup. |
| Primary crashes | **Not handled.** `heartbeatNs` exists but is never written or read, so a worker cannot tell a stale arena from a live one. Under `cluster` workers usually die with the primary, which is the only thing saving this today. The segment is reclaimed on restart because its name derives from the application's identity, not its pid. |
| Ring wrap | Lagging worker flushes its whole L1. |
| Layout change across versions | `magic` + `layoutVersion` in the header; mismatch refuses to attach rather than misreading. |
| Corrupt length field | Bounds-checked before every `memcpy`. |
| L1 arena fully pinned by live external strings | Fall back to copied heap strings until finalizers release slots. |

**Security boundary:** the segment is uid-scoped, mode 0600. Any process running as the same user can read every cached value. This is not safe for untrusted co-tenants, and must be documented plainly.

---

## 9. Measurements

Apple Silicon, Node 24.15.0, V8 13.6.233. Harness in `prototype/`.

> **Payload entropy matters enormously.** An earlier draft of this document reported
> LZ4 figures measured against `'x'.repeat(n)`, which compresses to nothing and is
> ~16x faster to compress than real data. Every number below uses JSON-shaped
> payloads with randomised field values (gzip 29–67%). Do not benchmark this
> system with repetitive filler.

### Call overhead

| Operation | ns/op |
|---|---|
| JS no-op function | 0.9 |
| Node-API no-op call | 8.1 |
| Node-API, read latin1 string arg | 17.7 |
| Node-API, arg + construct 200B string | 30.8 |
| JS `Map.get` (cached string) | 19.2 |

### String return strategy

| bytes | copy out | external per call | `Map` holding external |
|---|---|---|---|
| 200 | 30.0 | 58.0 | 20.6 |
| 1024 | 59.7 | 55.2 | 22.1 |
| 16384 | 438.9 | 58.9 | 21.6 |
| 262144 | 26350.3 | 55.8 | 21.4 |

External-string cost is **flat ~56ns** irrespective of size; copy cost is linear.
Crossover ~1KB. Caching the handle in a `Map` beats both at every size.

### L2 arena, end to end, uncompressed

`probe` = hash + index probe + `memcmp`. `getLen` = full seqlock read + copy.
`get` = plus V8 string construction. All three allocators agree within noise.

| bytes | probe | getLen | get (full) | set | JS `Map.get` |
|---|---|---|---|---|---|
| 64 | 26 | 36 | 42 | 45 | 17 |
| 1024 | 32 | 54 | 80 | 86 | 17 |
| 16384 | 35 | 335 | 830 | 620 | 17 |

**Those are a best case and were wrongly used as the headline.** They cycle 2000
keys in order, so index and entries (~200KB) stay cache-resident. Measured across
access order and keyspace (`bench/l2_latency.js`):

| value | keyspace | order | L2 hit | full `get()` |
|---|---|---|---|---|
| 64B | 2,000 | sequential | 42ns | 51ns |
| 64B | 2,000 | random | 57ns | 65ns |
| 64B | 200,000 | sequential | 91ns | 101ns |
| **64B** | **200,000** | **random** | **265ns** | **298ns** |
| 1KB | 200,000 | sequential | 156ns | 187ns |
| **1KB** | **200,000** | **random** | **445ns** | **497ns** |

The realistic figure is **~300–500ns**, not 42ns — a 7–12x correction. §6's
"150–400ns" was closer to the truth than §9's own headline.

### LZ4 on realistic data — the case against compression

| bytes | ratio | compress | decompress | memcpy |
|---|---|---|---|---|
| 64 | 94% | 210ns | 8ns | 1ns |
| 256 | 75% | 305ns | 24ns | 2ns |
| 1024 | 64% | 806ns | 155ns | 9ns |
| 4096 | 57% | 2984ns | 697ns | 37ns |
| 16384 | 51% | 11919ns | 3034ns | 183ns |

Measured through the real store, LZ4 is **the entire cost** of an operation:

| bytes | get uncompressed | get compressed | set uncompressed | set compressed |
|---|---|---|---|---|
| 256 | 40ns | 75ns | 84ns | 388ns |
| 1024 | 55ns | 205ns | 104ns | 1242ns |
| 4096 | 117ns | 791ns | 249ns | 4671ns |
| 16384 | 316ns | 3403ns | 749ns | 20118ns |

Compression makes reads **2–10x slower** and writes **5–27x slower**, to buy
roughly **2x density** — and it gets worse as values grow, so no size threshold
rescues it. On a 32MB default arena, the alternative to compressing is simply
allocating 64MB, which costs nothing anyone will notice.

### Allocator comparison — hit rate at fixed capacity

32MB arena, 60k keys, Zipf s=1.0, cache-aside, compression off. `SLAB` =
size-class free lists + CLOCK. `LOG` = circular log, FIFO eviction.
`LOG2` = circular log where a live entry with its reference bit set is
re-appended at the head instead of dropped (CLOCK semantics on a log).

| scenario | SLAB | LOG | **LOG2** |
|---|---|---|---|
| stable mixed sizes (64B–8KB), steady state | 71.7% | 72.3% | **75.0%** |
| after a shift to larger values (new keys) | 50.0% | 55.2% | **58.1%** |
| workload oscillating back to the earlier small keys | **87.6%** | 80.4% | 80.4% |

`LOG2` wins the two realistic cases. `SLAB` wins only the third, and for a
narrow reason: its stranded small-size classes are never reclaimed, so old
small entries survive a large-value phase and are still there if the workload
swings back. That is slab calcification being scored as a benefit by a
contrived oscillation — the same stranding costs it 8 points in the row above.

Write cost is identical across all three when the arena is not under pressure;
`LOG2`'s re-append only does work during eviction, and is capped at 64
relocations per allocation so a hot arena still makes progress.

### Does compression make sense at all? — measured at fixed budget

Compression is never a latency win; it is only ever a density win. Density only
matters while the working set does not fit. So the question is whether trading
latency for density ever beats simply buying the density with RAM.

Same workload, varying the data region, `LOG2`, foreground compression on write:

| data region | uncompressed hit / get | compressed (≥1KB) hit / get | compression buys |
|---|---|---|---|
| 16MB | 80.7% / 117ns | 85.5% / 355ns | +4.8 pts |
| 32MB | 87.7% / 122ns | 89.9% / 371ns | +2.2 pts |
| 64MB | 89.9% / 122ns | 89.9% / 352ns | **+0.0 pts** |

Compression costs ~3x on reads and ~9x on writes (176ns → 1729ns) at every
point, and its benefit decays to exactly nothing once the working set fits.

**At every row, spending 2x the memory dominates compressing.** 32MB
uncompressed (87.7%, 122ns) beats 16MB compressed (85.5%, 355ns) on *both*
axes. 64MB uncompressed matches 32MB compressed on hit rate at a third of the
read latency. Since L2 is one shared arena per host — not per worker — the
memory in question is tens of megabytes.

Break-even, if you genuinely cannot spend the RAM: the added cost is
~0.85 × 230ns per hit plus ~0.15 × 1550ns per miss ≈ 420ns per operation, against
a 4.8-point hit-rate gain. So compression pays only where a miss costs more than
**~8.8µs** — which is true of a Valkey hop (~50–200µs) or a database query, and
false of anything computed locally.

Threshold and acceleration, if it is enabled:

| policy | hit% | get(ns) | set(ns) |
|---|---|---|---|
| off | 80.7 | 117 | 182 |
| ≥256B | 85.8 | 372 | 1909 |
| **≥1KB** | **85.5** | **346** | **1729** |
| ≥2KB | 84.8 | 321 | 1521 |
| ≥4KB | 83.4 | 257 | 1027 |
| ≥1KB, LZ4 accel=4 | 84.5 | 341 | 1488 |
| ≥1KB, LZ4 accel=16 | 80.7 | 112 | 573 |

A 1KB floor is the right default: below it, ratios are 75–94% so it is nearly
pure cost. LZ4 acceleration does not rescue the write path — at accel=16 nothing
clears the "12.5% smaller" bar at all, so it degenerates to compression being
off. There is no setting that makes compression cheap.

**Verdict: off by default, off in v1 — and now off at build time too.** Since
nothing uses it, linking LZ4 unconditionally only made the addon unbuildable
anywhere without a system LZ4 at a hardcoded path. It is now an optional build
feature:

```
node-gyp configure build                      # default: no LZ4, no dependency
node-gyp configure build --turbocache_lz4=1   # link system LZ4
```

The default build has **no external dependencies at all**. `find_lz4.js` locates
LZ4 for the opt-in build via `pkg-config`, then the usual prefixes, honouring
`LZ4_PREFIX`. `Cache.hasCompression()` reports the capability, and asking for
`compress: true` on a build without it throws rather than silently storing
uncompressed.

Mixing builds is guarded rather than left to chance: the header records a
`FEATURE_LZ4` bit the first time a compressed entry is written, and a build
without LZ4 **refuses to attach** to such an arena with a message naming the fix,
instead of attaching and reporting silent misses for every compressed key.

### Background compaction — prototyped, and rejected

The idea: since the primary owns L2 and is off the read path, compress cold
entries in the background, keeping writes fast and recovering density only
under pressure. It was built and it works correctly. It is still not worth it.

Design as built: capture candidates walking forward from the tail, compress on
the **libuv threadpool**, apply back on the writer thread. Because a circular
log cannot reclaim space in the middle, "compress" means re-append the smaller
record at the head and repoint the index slot — i.e. LOG2's second chance, but
compressed.

**Race safety (works).** Only the LZ4 call is off-thread; capture and apply both
run on the single writer thread, so the sole exposure is the window between
them. It is closed by re-checking `(slot, offset, hash, version)` before
publishing, and again after the allocation (which can evict the source).
The `version` field is the global `++inserts` counter, so it is never reused —
strictly stronger than a per-key counter, which would be ABA-vulnerable across
an eviction and reinsertion of the same key. Compaction deliberately does not
bump the version or touch the invalidation ring, since the value is unchanged.

| test | result |
|---|---|
| every key overwritten during a widened 40ms window | **18,000 stale captures discarded, 0 wrong values, 0 resurrections** |
| realistic 5% overwrite rate during the window | 4,103 applied / 212 discarded — **95% make progress**, 0 wrong values |

**Value (does not justify it).** 16MB data region, 40k keys, Zipf s=1.0:

| configuration | hit rate | entries resident | read latency | complexity |
|---|---|---|---|---|
| plain | 80.8% | 10,321 | 129ns | — |
| + compaction, all entries near tail | 82.7% | 12,118 | **390ns (3.0x)** | async subsystem + race window |
| + compaction, cold entries only | 80.8% | 10,175 | 285ns (2.2x) | same |
| **plain, data region 16MB → 32MB** | **87.7%** | 20,459 | **121ns** | none |

Restricting to cold entries cuts the latency penalty but erases the entire
hit-rate gain — which is not a policy bug but the shape of the trade: the gain
comes precisely from compressing data that gets read. Meanwhile utilisation
falls to ~78%, because re-appending leaves garbage behind that the tail has not
yet reclaimed, eating much of the density won.

And simply doubling the arena — 16MB to 32MB, an amount nobody will notice —
delivers **+6.9 points, 3.6x the gain of compaction, at no latency cost and no
complexity.** The hit-rate curve then saturates near 64MB for this working set.

Conclusion: do not build it. The entry format keeps the `COMPRESSED` flag so a
genuinely memory-constrained deployment can opt in later.

### Two gaps found by measurement — both now fixed

**Gap 1: workers could not set CLOCK reference bits.** Reads happen in workers
holding a `PROT_READ` mapping, so they could not write a reference bit; every
earlier `LOG2` benchmark ran in-process where the reader *was* the writer.
Suppressing bit-setting collapsed `LOG2` (80.8%) to `LOG` (78.7%) — the entire
advantage.

*Fixed* with a **separate hints segment**: one byte per index slot, in its own
`shm` object opened `O_RDWR` by workers, while the arena's own descriptor stays
`O_RDONLY`. Isolation is therefore a property of the file descriptor, not merely
of the mapping — a worker cannot map the arena writable even deliberately, but
can still record what it read. The read path loads before storing, so a hot
entry already marked skips the store and workers do not ping-pong the cache line.

Verified end to end: a worker attached read-only, read exactly 100 of 5000 keys,
and the primary observed **exactly 100 reference bits set**. Arena writes from a
worker still fault with SIGBUS.

**Gap 2: tombstones accumulated without bound.** `HASH_TOMB` was never reclaimed
and `findSlot` stops only at `HASH_EMPTY`, so probes degraded to full-table
scans — 45ns → 342ns at **3% load factor**, and up to ~33µs with a larger live set.

*Fixed* with **backward-shift deletion** (Knuth 6.4 Algorithm R), which closes
the gap by relocating entries instead of leaving a marker, plus a **75% index
load ceiling**. The claim that this meant the index "can never saturate" was
**false**; see the review findings below.

| cumulative inserts | live | before | after |
|---|---|---|---|
| 65,536 | 2,001 | 45ns | 31ns |
| 400,000 | 2,001 | 342ns | 29ns |
| 1,000,000 | 49,152 | ~33,000ns | 41ns |

Probe cost is now flat. Live entries cap cleanly at 49,152 (75% of 65,536)
instead of drifting to 59,074 while inserts silently failed.

### A silent data-corruption bug, and a correction

Stress-testing the fixes surfaced a **pre-existing** bug that invalidates an
earlier claim in this document. The reported "22,257,202 reads, 0 torn values"
was **under-stressed**: the arena was large enough that the log rarely wrapped
over an offset a reader was holding. Tuned to force wrap-around (2MB arena, 800
keys, 6 readers) the original code produces **3–7 corrupt reads per ~24M**, and
it is present with or without the index changes.

Two distinct defects:

**a) Second-chance re-append wrote without checking for room.** `logDropTail`
relocated a surviving entry to the head, but that branch only runs while the log
is under allocation pressure — precisely when free space is scarce. It could
overwrite live records near the tail whose index slots still pointed at them.
Fixed by requiring `freeBytes >= bsz` before writing.

**b) The seqlock cannot detect log reuse.** A seqlock protects an *in-place
rewrite* of an entry. When an entry is evicted and the head wraps over its bytes,
that address is no longer an `Entry` header at all — `e->seq` becomes somebody
else's payload and can read as stable and even twice in a row. Because the same
keys are rewritten repeatedly, those bytes frequently hold an **older copy of the
same key**, so `memcmp` passes too, and a stale or torn value is returned.

*Fixed* by making index slots store the **monotonic log position** rather than a
physical offset (physical address is `pos & (dataBytes-1)`). The position never
wraps, so it can express liveness that an offset cannot: the bytes at `pos`
belong to record `pos` exactly while `logTail <= pos`. The reader loads the
published tail *after* copying; since the tail only advances, observing
`tailPub <= pos` proves the record was live for the entire copy.

This is the load-bearing correctness argument of the whole read path and should
be the first thing any reviewer checks.

After both fixes, the same wrap-heavy stress across five configurations —
~90M reads against ~28M concurrent writes — reports **0 corrupt reads**, and
read latency is unchanged (43/52/80/205/741ns at 64B–16KB).

### Arena sizing validation

`create()` did not check that header + index + ring actually fit. A 1MB segment
with 65,536 index slots (1MB of index alone) underflowed `totalBytes - dataOff`
into a huge unsigned value and hung. Now rejected, along with a non-power-of-two
`indexSlots`.

### Comparison against the Bugsee appserver cache

Measured against `Bugsee/appserver/code/components/shared/cache`, a production
implementation of the same shape: L1 `JsonLru` per worker, L2 in the primary's
heap reached over `cluster` IPC, plus TTL, alias refs and an L3 adapter.
Both sized identically (L1 2MB/worker, L2 256MB), same Zipf s=1.0 workload,
90% read / 10% write, cache-aside, shared keyspace. Harness in `bench/`.

**Single process** — neither cache has an IPC peer, so this is each engine's
in-process fast path. Values are objects, so *both* pay a JSON encode/decode at
the application boundary (bugsee internally, turbocache in the caller).

| scenario | turbocache | bugsee | hit rate (tc / bs) |
|---|---|---|---|
| 60k keys, exceeds L1 | 304k ops/s | **321k ops/s** | 87.4% / 58.4% |
| 1k hot keys, fits L1 | **440k ops/s** | 392k ops/s | 99.7% / 99.7% |
| 60k keys, **opaque string values** | **1,722k ops/s** | 530k ops/s | 87.4% / 56.8% |

With object values the JSON codec dominates and the two are within ~10% — bugsee
is actually *faster* on the large working set, because in a single process its
misses cost nothing (no L2 to consult) while turbocache pays a real L2 lookup.
The 3.2x gap appears only with opaque payloads, where turbocache stores bytes
verbatim and bugsee's JSON-only API must still encode.

**Cluster, 1 primary + 4 workers** — this is where the architectures separate.

| workers | turbocache (`bytes`) | hit rate | bugsee | hit rate |
|---|---|---|---|---|
| 1 | 213k ops/s | 80.4% | 57k ops/s | 80.4% |
| 2 | 374k ops/s | 85.7% | 89k ops/s | 68.4% |
| 4 | 666k ops/s | 90.5% | 80k ops/s | 30.2% |
| 8 | **1,040k ops/s** | **94.1%** | **42k ops/s** | **12.8%** |

turbocache scales close to linearly because reads never touch the primary.
bugsee plateaus near 80k regardless of worker count: every L1 miss is an IPC
round-trip through one event loop, and past saturation its client either times
out (100ms) or hits the 256-request pending cap, resolving `undefined` — which
the application sees as a miss. Its L2 is not the problem; both L2s held exactly
49,146 entries (62MB of 256MB), so the data was there and simply could not be
reached in time. This is the bottleneck predicted in decision 1, measured.

At 4 workers with object values: p50 4.0µs vs 56µs, p99 19µs vs 115µs,
p99.9 173µs vs 4.7ms. With opaque string values, 1,540k vs 72k ops/s.

**Caveats that matter for reading these numbers:**

1. **The write paths are not equivalent.** turbocache's `set` is fire-and-forget
   — buffered and batched to the primary, unacknowledged, visible to other
   workers about a tick later. bugsee's `set` awaits an ack. turbocache is
   trading write visibility for speed, and part of its margin is that trade
   rather than pure efficiency.
2. **bugsee is complete; turbocache is a prototype.** TTL, alias refs, an L3
   adapter, key validation, backpressure and worker-death handling all cost work
   per operation that turbocache simply does not do yet.
3. **Single-process misses are unrealistically cheap here.** A miss just refills
   from a pre-built value. In a real service a miss costs a database query, so
   the hit-rate column would dominate throughput far more than it does above.

### Resolving the decision 4 / decision 5 tension

Decision 4 limits values to bytes and strings; decision 5 says L1 caches the
*decoded* value so hits skip decoding. With object workloads these conflicted:
the cache only ever saw an encoded string, so L1 cached a string and the
application re-parsed it on **every hit** — exactly the cost decision 5 exists
to remove.

**Resolution: the two decisions apply at different boundaries, bridged by an
optional caller-supplied codec.**

```js
new Cache({ codec: { encode, decode } })     // e.g. JSON, msgpack, protobuf
```

- Decision 4 holds at the **L2 and wire boundary**: L2 stores only bytes, IPC
  carries only bytes, and the arena format is unchanged.
- Decision 5 holds at **L1**: with a codec, `set` encodes once (L2 needs bytes
  regardless, so this is not extra work) while L1 keeps the **decoded** value,
  and an L1 hit returns it with no decoding at all.
- With **no** codec the value is already opaque bytes, L1 stores it as-is, and
  decision 5 is satisfied trivially. This stays the fastest configuration.

| scenario | app-side codec | **cache-owned codec** | bugsee |
|---|---|---|---|
| 1k hot keys, fits L1 | 426k ops/s | **1,529k ops/s** | 382k ops/s |
| 60k keys, exceeds L1 | 291k ops/s | **366k ops/s** | 285k ops/s |
| cluster, 4 workers | 661k ops/s | **778k ops/s** | 79k ops/s |

On an L1 hit, p50 goes from 1334ns to **42ns**. The gain tracks L1 hit rate, so
it is largest exactly where a cache is meant to spend its time.

**Three consequences, all real:**

1. **Aliasing is now a live hazard.** L1 returns the same object reference on
   every hit. Decision 7 got away with sharing because strings are immutable;
   objects are not, so one caller mutating a returned object corrupts the cache
   for every other reader in that worker. Default is a documented do-not-mutate
   contract, matching decision 7's treatment of strings. `freeze: true`
   deep-freezes at insert instead, turning mutation into a thrown error —
   measured cost 25–30% (1,529k → 1,125k ops/s).
2. **The L1 byte budget becomes an estimate, not a cap.** JS cannot measure an
   object's heap footprint, so the budget counts encoded bytes scaled by
   `heapFactor`. See "Can object size be measured?" below for why no better
   estimate exists, and what to do instead. Measured against real heap usage for
   JSON-shaped objects:

   | encoded size | heap per object | ratio |
   |---|---|---|
   | 200B | 641B | 3.21x |
   | 741B | 2142B | 2.89x |
   | 2846B | 7942B | 2.79x |

   A default of 3 is therefore calibrated rather than guessed, but it is
   shape-dependent — objects dominated by long strings or typed arrays will sit
   well below it. The "hard byte cap" claim in section 4 is weakened to an
   estimate whenever a codec is in use.
3. **Effective L1 capacity drops by `heapFactor`**, so on a working set larger
   than L1 more reads fall through to L2 (161k L1 hits becomes 132k in the 60k-key
   scenario). Net throughput still improves, but by 26% rather than 3.6x.

### Can object size be measured? No - and a better estimate is not the answer

**Where L1 crosses into native.** An L1 *hit* in the primary crosses nothing —
it is a plain `Map` lookup, which is why it measures 42ns. A worker's L1 hit
crosses once, for the `ringHead()` drain check. Every L1 *insert* already calls
`hashKey()`, so a size measurement there would cost no extra boundary crossing.

**V8 exposes no per-object size to embedders.** `GetShallowSize()` exists only
on `HeapGraphNode` — inside a heap snapshot, which is stop-the-world. Node-API
has nothing. Confirmed against the Node 24.15 headers.

**A native structural estimate was built and is worse on both axes.** It walks
the value through Node-API and models V8 layout (Smi 0, HeapNumber 16,
SeqOneByteString 16+len, JSObject 16+8n, JSArray 16+16+8n), counting internalised
property names and shared hidden classes as zero. Against ground truth (measured
`heapUsed` delta per object, after forced GC):

| estimator | 645B object | 2144B object | 7946B object | cost per call |
|---|---|---|---|---|
| **`encodedBytes x 3`** | **-7%** | **+4%** | **+7%** | free — length already known |
| native structural walk | -26% | -17% | -14% | **5825ns** |
| `v8.serialize().length` | -73% | -71% | -70% | 3506ns |

The walk consistently undercounts because backing stores, allocation alignment
and per-object bookkeeping cost more than the model, and shared property names
cannot be attributed to any one instance. It is also ~5x more expensive than the
`JSON.stringify` it would accompany (1191ns). Tuning its constants would only
curve-fit toward the accuracy `encodedBytes x 3` already delivers for free.

**The productive answer is to stop needing per-object accuracy.** The point of
the byte budget is to bound memory; bound the memory directly instead. A guard
reads `v8.getHeapStatistics()` after a GC and sheds L1 when the live set exceeds
a configured fraction of the heap limit:

| configuration | retained live heap | L1 entries kept |
|---|---|---|
| guard off, 1GB byte budget | 445MB (50% of limit) | 200,000 |
| guard at 40% | 297MB (33%) | 128,998 |
| guard at 20% | **121MB (14%)** | 46,079 |

The deliberately-wrong 1GB budget bound nothing; the guard bounds what actually
matters. Two things it is not:

- **It needs the event loop to turn.** GC notifications arrive on a later tick,
  so a fully synchronous loop never receives them. Fine for a server — and a
  cache that never yields cannot flush its IPC write batch either.
- **The signal must be read after a GC.** Sampling `used_heap_size` at an
  arbitrary moment includes uncollected garbage, so shedding *raises* the
  reading and the guard thrashes. A first attempt did exactly that, ending with
  higher peak heap than no guard at all.

So: `heapFactor` stays the sizing mechanism, and the guard is the backstop that
makes its inaccuracy non-fatal rather than something to engineer away.

### Primitives-only mode

Restricting accepted values to `string | number | boolean | null` fixes, in one
move, the three things the codec mode could not. All three verified:

1. **Byte accounting becomes exact.** A flat V8 string costs `16 + len`
   (one-byte) or `16 + 2*len` (two-byte), 8-aligned. Measured against real heap
   usage:

   | kind | len | measured | predicted | error |
   |---|---|---|---|---|
   | one-byte | 32 | 51B | 48B | -6% |
   | one-byte | 1024 | 1041B | 1040B | -0% |
   | one-byte | 8192 | 8209B | 8208B | -0% |
   | two-byte | 1024 | 2064B | 2064B | -0% |

   Smis and `true`/`false`/`null` genuinely cost nothing; a non-Smi number is a
   16-byte HeapNumber. So `heapFactor` disappears and the budget is a real cap
   rather than an estimate.
2. **The aliasing hazard disappears.** Primitives are immutable, so there is
   nothing to mutate, no do-not-mutate contract, and no need for `freeze`.
3. **No codec to configure.**

**One hole, found and closed.** A V8 `SlicedString` keeps its parent alive, so a
cached substring can retain an arbitrarily larger document. Measured with an 8MB
parent, keeping one derived 1MB string and dropping the parent:

| kept value | retained |
|---|---|
| the whole 8MB parent (control) | 8.00MB |
| **1MB substring, as-is** | **8.00MB — the entire parent** |
| 1MB substring via `native.flatten()` | **1.00MB — exactly its own bytes** |

Primitives mode therefore flattens strings on insert, in native. This costs
nothing extra in boundary crossings because the insert path already calls
`hashKey()`, and the flatten itself measures ~42ns for a 200-char value —
cheaper than the hash call beside it.

**The cost of the mode** is ~20% throughput for flatten plus exact sizing
(1,542k to 1,227k ops/s on opaque payloads, still 2.4x the bugsee cache), and
that object workloads must encode in the caller and therefore decode on every
L1 hit — 291k versus 1,583k measured.

### Three coherent value modes

| mode | L1 holds | accounting | aliasing | L1 hit cost |
|---|---|---|---|---|
| **bytes** | the value's bytes | **exact** | **none** | free |
| JSON-always (the bugsee design) | JSON string | exact | none | parse per hit |
| codec, decoded L1 | decoded object | `heapFactor` estimate | **yes** | free |

Worth stating plainly: the bugsee cache's fixed-JSON design gets exact
accounting and freedom from aliasing for the same structural reason primitives
mode does — its L1 holds a string. That simplicity is real, and its price is one
parse per hit, which is what the cluster comparison measured.

**Recommendation:** primitives is the default. The codec mode stays available
for object-heavy workloads that are dominated by L1 hits, carrying its two
documented caveats. This keeps the safe, exactly-accountable configuration as
the one users get without reading anything.

### JSON fast paths on Node 26

Measured on Node 24.15.0 and Node 26.8.1, same machine, 1.4KB payload.

**The premise holds, and then some.** `JSON.stringify` of a pure-ASCII object
went from 2324ns to **1524ns, 34% faster**. `JSON.parse` improved about 11%.

**But the slow paths did not improve, so falling off one now costs more:**

| variant | Node 24 | Node 26 | penalty on 24 | penalty on 26 |
|---|---|---|---|---|
| plain object (fast path) | 2324ns | **1524ns** | — | — |
| 2-space indent | 3118ns | 3260ns | 1.29x | **2.11x** |
| replacer function | 5605ns | 5409ns | 2.32x | **3.51x** |
| all values non-ASCII | 2560ns | 3096ns | 1.10x | **2.03x** |

Two things follow. A `replacer` now costs 3.5x rather than 2.3x. And a heavily
non-ASCII payload is not merely slower than ASCII on Node 26 — it is **slower
than the same payload was on Node 24** (3096ns vs 2560ns). The new fast path is
ASCII-oriented, and it is evaluated per string: injecting a *single* non-ASCII
character into a 41-string document cost nothing measurable (0.99x); only when
most strings are non-ASCII does the 2x appear.

**`JSON.parse` is insensitive to string representation.** Flat one-byte, sliced,
cons, and strings returned from our arena all parse within 2% of each other on
both versions. So flattening is worth doing for memory (a slice retains its
parent) but buys nothing for parse speed.

**A replacer is never acceptable, and this is now enforced two ways.** The rule
is absolute: `JSON.stringify(v)` and `JSON.parse(s)` take exactly one argument.

1. **Repo-wide lint.** `json_fastpath_test.js` scans every `.js` file in the
   project for `JSON.stringify(`/`JSON.parse(` calls with more than one
   top-level argument, using balanced-paren scanning rather than a regex so
   nested calls are not miscounted, and stripping comments first. A file that
   measures the slow paths on purpose opts out with a
   `json-fastpath-lint: allow` marker, so the exemption is visible in the file
   rather than hidden in the linter.
2. **Construction-time codec check.** The codec is supplied by the caller, where
   no source lint can reach, so `assertFastCodec` inspects
   `Function.prototype.toString` of both `encode` and `decode` and rejects any
   `JSON.stringify`/`JSON.parse` call with a second argument. Native or bound
   functions report `[native code]` and are accepted; codecs that are not JSON
   at all are not affected. `allowSlowCodec: true` overrides it.

Output probing alone is not sufficient, which is why the source check exists: an
**identity replacer** — `JSON.stringify(v, (k, x) => x)` — produces byte-identical
output while still costing 3.51x, so nothing about the result reveals it.

| codec | verdict |
|---|---|
| `JSON.stringify` / `JSON.parse` directly | accepted |
| `v => JSON.stringify(v)` | accepted |
| `v => JSON.stringify(Object.assign({}, v))` (nested call) | accepted |
| `v => JSON.stringify(v, null, 2)` | **rejected** |
| `v => JSON.stringify(v, (k, x) => x)` | **rejected** |
| `v => JSON.stringify(v, ['a'])` | **rejected** |
| `s => JSON.parse(s, (k, x) => x)` | **rejected** |
| a non-JSON codec (msgpack, protobuf) | accepted, unaffected |

**A real bug this surfaced.** The prototype encoded every value through
`napi_get_value_string_latin1`, silently mangling any non-ASCII string — a
limitation noted earlier and now fixed. Values are classified at insert:
ASCII is stored one byte per character and rebuilt with
`napi_create_string_latin1`; anything else is stored as UTF-8 and rebuilt with
`napi_create_string_utf8`. This both fixes correctness and keeps ASCII values on
the one-byte representation that the Node 26 stringify fast path favours if the
application re-encodes them. The `FLAG_LATIN1` bit the entry format already
reserved is what carries the classification.

**End to end**, with JSON on the hot path (codec mode, 60k-key working set):
444k ops/s on Node 24, **513k ops/s on Node 26** — a 16% gain for free.

### Node-API ABI stability, verified

The addon compiled against Node 24.15 headers loads and runs unmodified on Node
26.8.1. This is decision 12 paying off directly: had the design used V8 fast
calls it would have needed a rebuild and a new prebuild for that major, for a
saving measured at ~6ns per call.

### Mutation safety: what the bugsee cache was buying with JSON

The bugsee cache stringifies on write and parses on read at every layer. That is
not incidental overhead — it buys two properties deliberately: **every read
returns a fresh object, so no layer can be corrupted by a caller**, and **any
JSON-serialisable value is accepted**. Any design that caches decoded objects to
avoid the parse has to pay for those properties some other way.

**The hazard, as originally built.** `set(key, obj)` put the *caller's own*
object into L1. So a caller could corrupt the cache without ever calling `get`:

```
set('acct', user)          // user = { role: 'viewer' }
user.role = 'admin'        // caller mutates a variable it still holds
get('acct').role           -> 'admin'    L1 followed the mutation
L2 (other workers)         -> 'viewer'   diverged; version never changed
...L1 evicts...
get('acct').role           -> 'viewer'   silently REVERTED
```

The revert is the worst part: the bug appears and then disappears on its own,
at a time determined by eviction pressure.

**Two fixes, both now on by default in codec mode.**

- `isolate` — `set` decodes its own encoding to produce the L1 object, so the
  cache holds something the caller has never seen. The encoding was needed for
  L2 anyway; the extra cost is one `decode` per `set`.
- `freeze` — the cached object is deep-frozen, so mutating a `get` result throws
  instead of silently corrupting L1.

| configuration | caller mutates its own object | caller mutates `get()` result |
|---|---|---|
| codec, `isolate:false` | **corrupts, then reverts** | **corrupts** |
| codec, `isolate:true` | safe | **corrupts** |
| **codec, isolate + freeze (default)** | safe | throws `TypeError` |
| **primitives (default mode)** | safe | safe |

**What each guarantee costs** (300k ops, 90/10 read/write):

| configuration | L1-resident | exceeds L1 | guarantee |
|---|---|---|---|
| codec, `isolate:false` | 1,545k | 411k | none |
| codec, `isolate:true` | 1,068k | 320k | set-side only |
| **codec, isolate + freeze** | **813k** | 235k | full |
| primitives / parse-per-get | 413k | 291k | full |

The useful result: **freezing buys the same immutability guarantee as parsing on
every read, at roughly twice the throughput** — 813k versus 413k on L1-resident
data. The parse is paid once per insert instead of once per read.

They differ in ergonomics, not safety. Parse-per-get hands back a **fresh mutable
object every time**, which is the friendlier contract — the caller may do
whatever it likes with it. Freezing hands back a **shared immutable object**, so
a caller that needs to modify must clone it first. That is the real trade, and
it is why primitives — where the application owns the codec and therefore gets a
fresh object per parse, exactly as the bugsee cache does — remains the default
mode. Codec mode is the opt-in for workloads dominated by L1 hits.

| Claim | Result |
|---|---|
| Workers read a live arena through `PROT_READ` while the primary writes | **22,257,202 cross-process reads against 11,660,000 concurrent writes, 0 torn or wrong values** (4 forked readers, 5s, blocks constantly reused at changing sizes) |
| A worker cannot corrupt the arena | Write through a worker mapping faults with **SIGBUS**; primary reads correctly afterwards. Enforced by the MMU, not by convention. |

Seqlock correctness needs TSAN before this is trusted in production — 22M clean
reads is strong evidence, not proof.

### Type conversion between L1 and L2

Two conversions on the path, answering different questions.

```
  app value ──codec.encode──► string ──native set──► arena bytes + type flags
   (L1 holds THIS form)                               (L2 holds this)
```

The **codec layer (JS)** converts application value to string, and exists only in
codec modes. L1 holds the value on the *application* side of that arrow, which is
what makes an L1 hit free of decoding. The **native layer (C++)** converts a JS
value to arena bytes, and this is where type must be preserved — L2 is read by
other processes that share no JS state.

| JS value | stored in the arena | flags | rebuilt as |
|---|---|---|---|
| ASCII string | one byte per char | `STRING\|LATIN1` | `create_string_latin1` |
| non-ASCII string | UTF-8 | `STRING` | `create_string_utf8` |
| number | the 8 raw bytes of the double | `NUMBER` | `create_double` |
| boolean | one byte | `BOOL` | `get_boolean` |
| null | zero bytes | `NULL` | `get_null` |
| BigInt | sign byte + 64-bit words | `BIGINT` | `create_bigint_words` |

Doubles are stored raw rather than as text: exact, no parsing, verified to
round-trip `-0`, `NaN`, `±Infinity`, subnormals and `MAX_VALUE`. A stored `null`
stays distinguishable from a miss.

Two bugs this analysis found, before the type tags existed: **numbers and
booleans never reached L2 at all** (they lived in L1 only, vanished on eviction,
were invisible to other workers — while `get` looked correct until then), and
**`null` threw** on both paths from taking `.length` of it.

### Type support across the three modes

Measured end to end — set, forced L1 eviction, read back through the arena.

| input | `bytes` | codec: JSON | codec: `v8.serialize` |
|---|---|---|---|
| string / number / boolean / null | exact | exact | exact |
| `BigInt` | exact | rejected | exact |
| `Date` | rejected | **`string`** | `Date` |
| `Array` / `Object` | rejected | exact | exact |
| `Map` / `Set` | rejected | **`{}`** | preserved |
| `Uint8Array` | rejected | **plain object** | `Uint8Array` |
| `RegExp` | rejected | **`{}`** | `RegExp` |

Primitives rejects loudly; JSON converts silently. A cache that quietly changes
your types is worse than one that refuses them.

### structuredClone for L1: measured, rejected for isolation

Cloning the cached object per read is the obvious way to hand back something
mutable. It is the slowest option, and Node 26 widens the gap because it sped up
JSON and not structured cloning:

| payload | freeze (shared) | `structuredClone` | `JSON.parse(str)` |
|---|---|---|---|
| 201B | 8ns | 1675ns | 604ns |
| 1411B | 4ns | 9533ns | 4133ns |
| 7311B | 4ns | 44026ns | 18046ns |

2.0–2.4x slower than parsing the equivalent string, and parsing needs that string
kept in L1 beside the object. Freezing is three orders of magnitude cheaper than
either. V8 structured serialization still earns a place — not as a per-read
clone, but as a **codec**, where it encodes to bytes for L2 exactly as JSON does.

### Why the codec-free mode is called `bytes`, not `primitives`

It was called `primitives` and then accepted `Buffer` and `TypedArray`, which are
not primitives. That was incoherent, and the cause was ordering: decision 4 fixed
the accepted value types before the three storage modes existed, so when binary
support finally landed it was attached to the only codec-free mode without
revisiting the name.

Removing binary from it would have been worse. Bytes are the most directly
storable thing there is, and the alternative is routing them through a
serializer:

| 4KB `Buffer` | set | get |
|---|---|---|
| codec-free path | **861ns** | **906ns** |
| via `direct` (v8 codec) | 4598ns | 3531ns |

5.3x on writes and 3.9x on reads to serialise something that is already bytes.

So the behaviour was right and the name was wrong. The mode means **no codec:
the native layer encodes the value itself** — scalars become their byte
representation, binary is stored verbatim, and anything that would need a codec
is rejected loudly. `'primitives'` is still accepted as a legacy alias.

### Storage modes

`storage: 'bytes' | 'direct' | 'safe'`.

| | `bytes` (default) | `direct` | `safe` |
|---|---|---|---|
| accepts | scalars only, rejects rest | any structured-cloneable value | any JSON value |
| encoding | none — the app owns it | `v8.serialize` | `JSON.stringify` |
| L1 holds | the primitive | the **decoded, frozen** value | the **encoded string** |
| per read | nothing | nothing | one `JSON.parse` |
| result | immutable by nature | shared and frozen | **fresh and mutable** |
| byte accounting | **exact** | estimated (`heapFactor`) | encoded length |

`safe` means *mutation*-safe: every read is a fresh object, so a caller can do
anything to it. It is not type-safe — it is precisely the mode that turns a
`Date` into a string. `direct` is the type-faithful one. Different safeties, both
real, and the docs must say which.

**A hole in `direct` that JS cannot close.** `Object.freeze` throws on an
ArrayBuffer view with elements, and `ArrayBuffer.prototype.transferToImmutable`
exists in neither Node 24 nor 26 (checked). So the object graph is frozen but
typed-array **contents** stay writable: a caller writing into one corrupts L1 for
its own process until eviction returns the arena's copy. Values holding typed
arrays want `safe` mode, or a defensive copy.

### Mode scorecard

From `bench/modes_report.js`, which is repeatable.

**Validity** — 18 types incl. `-0`, `NaN`, cycles:

| | exact | silently converted | rejected | lost |
|---|---|---|---|---|
| `bytes` | 11/18 | **0** | 7 | 0 |
| `direct` | **18/18** | **0** | 0 | 0 |
| `safe` | 9/18 | **8** | 1 | 0 |

**Safety** — can a caller corrupt the cache?

| vector | `bytes` | `direct` | `safe` |
|---|---|---|---|
| mutate the object passed to `set` | n/a | safe | safe |
| mutate the `get()` result | n/a | throws | safe |
| mutate a nested object in the result | n/a | throws | safe |
| write into a typed array in the result | n/a | **CORRUPTED** | n/a |
| survives L1 eviction unchanged | safe | safe | safe |

**Consistency** — 6,000 randomised ops over 300 keys, identical stream per mode:
zero mismatches between what L1 serves and what the arena serves after eviction,
in every mode; a read-only worker reads 200/200 correctly in every mode.

**Performance** — 200k ops, throughput / p50:

| workload | `bytes` | `direct` | `safe` |
|---|---|---|---|
| reads dominate, fits L1 | 437k / 99% | **1,173k / 99%** | 438k / 99% |
| mixed 90/10, exceeds L1 | 314k / 84% | 177k / 84% | 329k / 84% |
| write-heavy 50/50 | 303k / 85% | 126k / 85% | 328k / 85% |

Cells are throughput / hit rate. The swing across the diagonal is nearly an
order of magnitude: `direct` is 2.7x the field when reads dominate and L1 holds
the working set, and last everywhere else — `v8.serialize` on every write is the
whole cost. Choose by read/write ratio and type needs, not by a global default.
Note this ranking **inverts in a cluster**, where `safe` leads; see the full
matrix above.

### ThreadSanitizer, run

TSAN **cannot observe races between processes** sharing an mmap — it tracks
happens-before within one process, and the real deployment is a writing primary
and reading workers. So the harness models them as threads over the same arena
code: identical atomics, fences and seqlock, with only the isolation boundary
changed. `prototype/tsan/run_tsan.sh` builds and runs it.

**It found a real bug.** The CLOCK reference bits were a plain `uint8_t` array,
written by the primary (clearing and relocating them) while every worker
read-modify-writes them. That is an unsynchronised concurrent access — a genuine
data race, not a benign one. They are now `std::atomic<uint8_t>` with relaxed
ordering: free at runtime on ARM, and well-defined. TSAN then reported zero
races in steady state.

**And it confirmed the one deliberate race.** Driven into constant log
wrap-around, TSAN reports 20–36 races per run, all in the writer's payload
`memcpy` (`storeSet` and `logDropTail`'s second-chance re-append) against a
reader's payload copy. That is the defining trick of a seqlock: the copy races,
and the sequence re-check detects the torn read afterwards. Across every
configuration the harness observed **CORRUPT=0** — millions of reads, no torn or
wrong value ever escaped — so the detection works. But it is undefined behaviour
by the letter of the C++ memory model, and making it defined would require
atomic per-word payload access instead of a vectorised `memcpy`, which is
exactly the cost the design exists to avoid.

Rather than suppress it — which would hide future bugs in those same functions —
the gate asserts that the **set of racing sites never grows**:

| scenario | corrupt | races | sites |
|---|---|---|---|
| steady state | 0 | 0–1 | writer payload copy |
| constant wrap-around | 0 | 36 | `logDropTail`, writer payload copy |
| wrap + index pressure | 0 | 36 | `logDropTail`, writer payload copy |
| high index load factor | 0 | 21 | writer payload copy |

Any site outside that allowlist, or any non-zero corrupt count, fails the run.
Residual risk, stated plainly: a sufficiently aggressive compiler could in
principle exploit the UB in the payload copy. The fences around it and the
`-O1` build make that unlikely, and the pattern is used this way in production
systems everywhere, but it is not a proof.

### Tuning the two arbitrary constants — and a bug they exposed

**The second-chance budget was capping a mechanism that had already stopped
working.** Instrumenting how often re-append actually fires, with live hot
entries at the tail:

| budget | tail meets live entry | re-appended | **skipped, no room** |
|---|---|---|---|
| 64 | 36,713 | 512 (1.4%) | **35,681 (97%)** |

The `freeBytes >= bsz` guard added earlier to fix a corruption bug was blocking
97% of second chances — because `logDropTail` is *called from* the eviction loop,
so free space is short by definition. Second chance was effectively dead in a
full arena, which is exactly when eviction matters.

*Fixed with a zero-copy path.* When the log is full the head lands on the tail's
own bytes (`hp == phys`). The record does not need to move at all: positions are
monotonic, so re-publishing it at the new position and advancing both pointers
grants another lap for free — no `memcpy`, no free space required. Re-appends
went from 512 to 30,283 at budget 8, and **`LOG2`'s advantage over `LOG` grew
from ~2.5 to 4.4 points** (76.3% vs 71.9%), so decision 16 now rests on a
mechanism that actually runs.

*Budget value.* Hit rate saturates at 8 and is flat to 8192:

| budget | 0 | 1 | 8 | 32 | 64 | 1024 | 8192 |
|---|---|---|---|---|---|---|---|
| hit rate | 85.6% | 85.9% | **86.3%** | 86.3% | 86.3% | 86.3% | 86.3% |

Default is now **16** — saturated with margin, at no measured cost.

**Ring capacity is a time budget, not a count.** A worker that fails to drain
before the head laps it must flush its entire L1. The ring is appended *only by
the primary*, so its rate is the primary's apply throughput — measured at
**647k records/s**:

| ring records | bytes | headroom |
|---|---|---|
| 8192 (old default) | 128KB | **12.7ms** |
| 65536 | 1MB | 101ms |
| 262144 | 4MB | 405ms |

12.7ms is roughly one *minor* GC. A major GC (10–100ms) would flush every
worker's L1. Capacity is now derived from the arena — 64KB records or 4% of the
arena, whichever is smaller — giving ~100ms on the default 128MB arena for 0.8%
of it, and degrading gracefully on small arenas (4MB arena keeps 3.1% and 13ms).

### Namespaces: soft quotas through the eviction path

The problem was concrete: with `namespace` as nothing but a key prefix, a hot
namespace evicts a cold one entirely.

| | cold survivors | cold bytes | hot bytes |
|---|---|---|---|
| no quotas | **0 / 1000** | 0KB | 4096KB |
| cold 1MB / hot 2MB | **942 / 1000** | 508KB | 3588KB |

*(8MB arena, ~4MB data region. `cold` writes 1000x500B once; `hot` then writes
30000x500B — about 20x the arena.)*

The solution needs no new structure, because the zero-copy second chance made
protection free. Each entry carries a namespace id; the header tracks live bytes
and a quota per namespace. At the tail:

- namespace **has a quota and is under it** → protected, given another lap
- namespace **has a quota and is over it** → dropped
- namespace **has no quota** → the plain CLOCK reference bit decides, competing freely

Progress is guaranteed whenever the quotas sum to no more than capacity: a full
arena then necessarily contains at least one over-quota namespace, so something
is always droppable. The budget cap is the backstop if they are over-committed.

`clearNamespace()` drops one namespace's entries by scanning the index — O(slots),
and clearing is rare. Quotas are **soft**: a namespace may exceed its quota while
space is free, and is only pushed back under pressure, which is the behaviour you
want from a cache.

This also exposed a missing capability: there was no way to bind a *second*
namespace in one process. `open()` now returns an additional handle onto the
arena the process already has, rather than trying to create it twice.

### Three operational bugs found by auditing what was still open

**The worker outbox was unbounded.** Writes batch until `setImmediate` fires, but
a worker doing a long *synchronous* burst never turns the event loop, so nothing
flushed. 60,000 sets produced **zero flushes and 37.5MB of retained worker heap**.
`process.send` can be called at any time — the tick is only there to batch — so
the outbox now flushes eagerly past a byte cap (1MB default):

| outbox cap | flushes | retained worker heap |
|---|---|---|
| unbounded | 0 | **+37.5MB** |
| 1MB | 31 | **+7.2MB** |

**A flush racing primary shutdown killed the worker.** The scheduled flush fired
after the primary had gone, and `process.send` failed with `EPIPE`. The failure
is *asynchronous*, so a `try/catch` around the call cannot see it — Node emits an
unhandled `'error'` event that terminates the process. Passing a callback to
`process.send` routes the failure to the callback instead; the dropped batch is
counted in `stats.flushDropped`. Losing a batch during shutdown is acceptable;
crashing the worker over it is not.

**A crashed primary leaked its shared-memory segment permanently.** `create()`
unlinks any prior segment of the same name, but the name was pid-derived, so a
crashed run's segment had a name nothing would ever reuse — verified: after a
`SIGKILL` the segment and its contents were still there, and there is no portable
way to enumerate POSIX shm on darwin, so the leak is invisible until reboot. At
the 128MB default that is roughly 500 crashes to exhaust 64GB. The name is now
derived from the application's identity (`argv[1]`/cwd, plus an optional
`TURBOCACHE_ID`), so a restart reclaims its own segment while different
applications on one host still get different ones. Verified: after a crash, a
restart finds the previous run's data gone.

### Adversarial review — findings and fixes

An independent adversarial review attacked the six load-bearing invariants, ran
ASan and UBSan for the first time, and audited the benchmarks. It found **six
severity-1 defects**. All are fixed; `prototype/review_regression_test.js` pins
every one.

| # | Defect | Fix |
|---|---|---|
| 1 | **Keys truncated at 511 bytes and folded to latin1**, so distinct keys returned *each other's values*. `get(K×511+'A')` → `"value-B"`; a never-set key returned data; `'中'` aliased `'-'`. L1 masked it within a process, so it surfaced only on L1 misses and cross-worker. | Keys are read as UTF-8 and capped at 1024 bytes; longer keys are rejected rather than truncated. |
| 2 | **Index saturation permanently bricked the arena.** The load-ceiling loop gave up after a fixed 4096 iterations, so under overwrite-heavy traffic `live` crept to 100%; `logAlloc` ran *before* `findFreeSlot`, so a failed insert left an uninitialised header whose garbage `blockSize` desynced the tail walk and orphaned the whole index. Repro ended with 60,000/60,000 sets failing and nothing readable, permanently. | Bound the loop by real progress (`logTail < logHead`) rather than a count; allocate, then secure the slot, then unlink the old entry; write a PAD record if the slot cannot be secured. |
| 3 | **TTL was lost whenever L1 refilled from L2** — the refill path never carried the entry's expiry, so any expiring value read once through L2 became immortal in that worker. | The arena reports the entry's expiry (`lastExpiresAt`), and the refill carries it into L1. |
| 4 | **The own-write ring skip served deleted values.** "Our own write, L1 is already correct" was false when L1 had been refilled from L2 between queuing and apply: a worker that deleted a key then read it in the same tick served the deleted value forever. | Own records are no longer skipped; the cost is one L2 refetch after each own write. |
| 5 | **The primary's L1 was never invalidated by worker writes.** `applyBatch` wrote the arena directly and the primary's drain is a no-op, so a primary that also reads served its own stale value indefinitely. | `applyBatch` drops the affected key from every cache instance in the process. |
| 6 | **A worker forked before the primary opened the arena silently created a second, writable one** and `shm_unlink`ed the primary's — total silent cache failure. | A worker never creates; it throws a message naming the ordering requirement. |

Severity 2, also fixed: `#byHash` grew without bound (32MB per 300k distinct
keys); a failed `set` destroyed the previous value; the worker-side size check
compared UTF-16 units against a UTF-8 limit and ignored the 4MB scratch cap;
`install()` attached twice if called between `fork()` and `'online'`;
`namespaceStats()` before an arena and any use after `close()` were hard
SIGSEGVs; `ringAppend` published the head before writing the record, leaving a
window in which a reader could permanently miss one invalidation.

Severity 3, also fixed: `ttlMs` near `INT32_MAX` overflowed and expired
immediately; TTL is now **millisecond**-precise rather than rounded up to whole
seconds (a 1ms TTL could be served for up to 2s); namespace names longer than 23
bytes silently shared one id and quota; the slab free-list link was a misaligned
`uint64_t` store (UBSan); compaction adjusted `liveBytes` but not `nsBytes`.

**What survived.** The reviewer could not break the `tailPub <= pos` liveness
proof, backward-shift deletion under concurrent probes, the zero-copy second
chance, or namespace quota accounting (`Σ nsBytes == liveBytes` exactly after
300k churn ops, no underflow, over-commit still made progress). ARM ordering
checks out. ASan+UBSan across ~100M reads produced no reports, and are now part
of `run_sanitizers.sh`. The TSAN gate was also flaky — its allowlist named only
writer-side frames, but TSAN attributes the deliberate race to whichever thread
detects it, so reader frames appear intermittently; both sides are now allowed.

### Full performance matrix, re-measured

Everything below was re-measured after the review fixes (UTF-8 keys, own-write
invalidation no longer skipped, TTL sweeping, the zero-copy second chance,
atomic reference bits). `bench/single_matrix.js` and `bench/cluster_matrix.js`,
sharing `bench/adapters.js` so both drive each implementation identically.

The workload is objects. Who encodes them differs by mode, and that cost is
charged where it falls: `bytes` has no codec, so the application stringifies and
parses, and those calls are inside the measurement.

**Cluster, 1 primary + 4 workers, 60k shared keys.**

| | 90/10 read/write | | | 50/50 write-heavy | |
|---|---|---|---|---|---|
| | ops/s | hit | p50 | ops/s | hit |
| `turbo/bytes` | 650k | 90.5% | 4.1µs | 551k | 89.4% |
| `turbo/direct` | 447k | 90.5% | 5.1µs | 315k | 89.6% |
| **`turbo/safe`** | **694k** | 90.5% | **3.9µs** | **638k** | 89.4% |
| bugsee | 82k | 30.4% | 54.8µs | 85k | 23.3% |

`safe` wins in the cluster, which inverts the single-process ranking. Its writes
are cheap (`JSON.stringify` on a hot path Node 26 made 34% faster) and it skips
the string flatten that `bytes` pays on every write. `direct` is last because
`v8.serialize` on every write is 2–3x JSON, and a cluster workload writes on both
explicit sets and miss-fills.

**Scaling is the headline.**

| workers | `turbo/bytes` | hit | bugsee | hit |
|---|---|---|---|---|
| 1 | 213k | 80.4% | 57k | 80.4% |
| 2 | 374k | 85.7% | 89k | 68.4% |
| 4 | 666k | 90.5% | 80k | 30.2% |
| 8 | **1,040k** | **94.1%** | **42k** | **12.8%** |

turbocache scales 4.9x across an 8x worker increase, and its hit rate *improves*
(80.4% → 94.1%) because more workers fill the shared arena faster. bugsee peaks
at two workers and then **goes backwards** — 89k to 42k — while its hit rate
collapses to 12.8%. At 8 workers the gap is **24.8x**.

That collapse is not a defect in bugsee so much as the architecture reaching its
limit: every L1 miss is an IPC round trip through one event loop, and past
saturation its client times out at 100ms or hits its 256-request pending cap and
resolves `undefined`, which the application sees as a miss. Its L2 holds the
data; it simply cannot be reached in time. Degrading rather than queueing without
bound is a deliberate and defensible choice.

**Tail latency** at 4 workers, 90/10: p99 18.5µs vs 121µs, p99.9 297µs vs 3.7ms.
At 8 workers bugsee's p50 alone reaches 181µs.

**What the modes are actually for**, given both tables:

- **`bytes`** — the default. Best when values are already scalars or bytes, and
  competitive everywhere. The app owns any codec, so it can skip encoding
  entirely for opaque payloads.
- **`direct`** — only when reads dominate *and* values carry real JS types. It is
  2.7x the field on an L1-resident read workload and last everywhere else.
- **`safe`** — best in the cluster, and the friendliest contract (a fresh mutable
  object per read). Pay for it in silent type conversion.

### Windows: the actual gap

Audited rather than estimated. The platform-specific surface is **31 lines out of
~2,600**, and all of the hard part sits in three functions in `store.h`:

| file | lines | platform-specific |
|---|---|---|
| `store.h` | 301 | 24 (8.0%) |
| `store_ops.h` | 650 | 2 (0.3%) |
| `binding.cc` | 887 | 4 (0.5%) |
| `turbocache.js` | 800 | 1 (0.1%) |

**The mechanical part** — `create()`, `attachReadOnly()`, `openHints()`:

| POSIX | Windows |
|---|---|
| `shm_open` + `ftruncate` + `mmap(RW)` | `CreateFileMapping(INVALID_HANDLE_VALUE, …)` + `MapViewOfFile(FILE_MAP_ALL_ACCESS)` |
| `shm_open(O_RDONLY)` + `mmap(PROT_READ)` | `OpenFileMapping(FILE_MAP_READ)` + `MapViewOfFile(FILE_MAP_READ)` |
| `munmap` + `shm_unlink` | `UnmapViewOfFile` + `CloseHandle` |
| `fstat` for size | already in the header (`totalBytes`) |
| `sysconf(_SC_PAGESIZE)` | `GetSystemInfo` — but note view offsets must be multiples of `dwAllocationGranularity` (64KB), not page size. Hints are a separate object mapped at offset 0, so this does not bite today; it would if hints ever moved back inside the main segment. |
| `clock_gettime(CLOCK_REALTIME)` x3 | `timespec_get` (C11, MSVC has it) |
| `usleep` (a test hook) | `Sleep` |

**The part that is not mechanical — lifetime semantics.** POSIX shared memory
persists until `shm_unlink`; a Windows file mapping is **reference-counted** and
dies when the last handle closes. That inverts one of our fixes: the "a crashed
primary leaks its segment until reboot" bug cannot occur on Windows, and the
stable-naming fix becomes merely harmless there. The flip side is that an arena
cannot outlive every process holding it, so a POSIX-only behaviour — a worker
attaching to an arena whose creator already died — has no Windows equivalent.
Any Windows port has to decide whether that divergence is acceptable or whether
the POSIX side should be constrained to match.

**Naming** also differs: POSIX wants `/name` (≤31 bytes on darwin), Windows wants
`Local\name` for a session-scoped object (`Global\` needs
`SeCreateGlobalPrivilege`). `defaultName()` needs a platform branch; `Local\` is
the right scope for a `cluster`.

**The safety guarantee needs re-establishing, not assuming.** The current claim is
descriptor-level: the arena fd is `O_RDONLY`, so a worker cannot map it writable
even deliberately. The Windows analogue is that `OpenFileMapping(FILE_MAP_READ)`
returns a handle whose access rights forbid a writable view. That *should* be
equivalent, but `protect.js` proves the POSIX case by observing a SIGBUS, and
Windows raises `EXCEPTION_ACCESS_VIOLATION` with no signal — so the test needs a
platform branch and the guarantee needs re-verifying on real hardware rather than
inherited by analogy.

**Two blockers already removed** while auditing:

- `binding.cc` contained one GNU statement-expression (`({ … })`), which MSVC
  rejects. Replaced with a plain function; there are now none.
- `binding.gyp` piped `find_lz4.js` through `cut`, and gyp's `<!()` runs in the
  platform shell — `cut` does not exist on Windows. `find_lz4.js` now prints a
  single field on request.

**And one that never existed**, thanks to vendoring: upstream `rapidhash.h`
already carries `_umul128`/`__umulh` paths for MSVC. The hand transcription it
replaced used `__uint128_t` unconditionally, which MSVC has no equivalent for —
so the transcription would have been a Windows blocker in its own right.

**Testing would be partial.** ASan exists for MSVC; **TSAN does not**, so the
sanitizer gate that guards the lock-free read path could not run on Windows at
all. That is an argument for treating Linux/macOS as the platforms of record for
concurrency verification regardless of whether the port happens.

## 10. Why not V8 fast calls

The original premise. It does not survive contact:

1. **The header is not shipped.** `v8-fast-api-calls.h` is absent from Node's public headers on 22.20.0, 24.14.0 and 24.15.0. In `v8-template.h`, `CFunction` is only forward-declared (line 21) — you can pass a `CFunction*` but cannot construct one. Node core uses fast calls because it builds against the full V8 tree. Using them from an addon means vendoring an unsupported internal header pinned to V8 13.6.233, where a layout mismatch is a runtime crash, not a build error.
2. **The prize is ~6ns.** A Node-API no-op is 8.1ns; a fast call would be ~2ns. Against ~21ns for an L1 hit and ~150ns+ for an L2 hit, that is noise.
3. **Node-API is worth more than 6ns.** A stable ABI means one prebuild per platform works on every current and future Node major — no rebuild treadmill, which was the largest recurring maintenance cost in the original plan.

Also, fast calls only accept `const FastOneByteString&`, so any two-byte key would have deoptimized to the slow path regardless.

---

## 11. Testing

- **Unit (native):** hash table probing and tombstones, slab allocator, LZ4 round-trip, seqlock under a deliberately racing writer.
- **Sanitizers:** `prototype/tsan/run_sanitizers.sh` runs TSAN across four arena configurations and ASan+UBSan across three, asserting zero torn values, zero sanitizer reports, and that the set of TSAN race sites never grows beyond the known seqlock payload copy. There is no CI to run it in.
- **Multi-process integration:** fork N workers, run randomized op streams against a JS `Map` reference model, assert every read is either correct-current or correct-stale-within-bound.
- **Crash tests:** `SIGKILL` a worker mid-`set`; assert the arena stays readable and self-consistent, and that surviving workers are unaffected.
- **Fuzzing:** feed the entry decoder adversarial arena bytes (corrupt lengths, torn seq values) and assert no out-of-bounds access.
- **GC-pressure tests:** hold long-lived references to external-string values, assert the pinned-bytes fallback engages and no use-after-free occurs.
- **Benchmarks:** L1 hit, L2 hit, miss, `set`, versus `lru-cache` and Redis over a unix socket.

---

## 12. Decision log

| # | Decision | Alternatives | Rationale |
|---|---|---|---|
| 1 | L2 in a shared arena, primary is sole writer; workers map it read-only | multi-writer shared memory; IPC request/response to primary | Sync reads with no cross-process locks and no macOS robust-mutex problem; a worker cannot corrupt the arena, and the primary is off the read path |
| 2 | Fully synchronous v1 API; async arrives as separate methods with L3 | `Promise` API from day one | Promise alloc + microtask tick is 100–300ns on a ~21ns operation; would pay the L3 tax for years before L3 exists |
| 3 | rapidhash **64**-bit + `memcmp` verification | 64-bit unverified; 128-bit unverified | Key text is stored for L3 anyway, so verification is nearly free — exactly correct instead of probabilistic, 8 bytes smaller, and enumeration stays possible |
| 4 | Values limited to `string` / `Buffer` / `Uint8Array` / `ArrayBuffer` | `v8::ValueSerializer` for arbitrary `any` | Structured clone costs 0.5–3µs and would dominate every other cost in the system |
| 5 | **L1 is a JS `Map`, not a native store** | native off-heap L1 | Measured: `Map` ~20ns/hit with zero allocation vs native 30ns (200B) to 439ns (16KB), allocating a fresh V8 string every hit |
| 6 | Large L1 values as external strings created once at insert | copy on every hit; externalize on every call | Flat ~21ns hits at any size with bytes off-heap; per-call externalization (~56ns) loses to copying below 1KB |
| 7 | Strings by reference, buffers copied | all by reference; frozen buffers | Immutability makes string sharing free and safe; mutable buffers would let one caller corrupt every reader |
| 8 | Invalidation via shared-memory ring buffer | IPC broadcast; per-entry version check on hit | `O(1)` per write regardless of worker count, zero IPC, and L1 hits touch one hot cache line instead of a cold per-entry one |
| 9 | CLOCK / sampled eviction | strict LRU | Strict LRU costs `delete`+`set` (~50–80ns) on every `Map` hit — more than tripling hit cost |
| 10 | **LZ4 off by default and in v1**; per-cache opt-in with a 1KB floor | compress above a threshold; compress in both layers | **Overturned by measurement.** Compression is a density win only, costing ~3x reads and ~9x writes. At a fixed 16MB budget it buys +4.8 points, but 32MB uncompressed beats 16MB compressed on *both* hit rate and latency, and the benefit reaches exactly zero once the working set fits. L2 is one arena per host, so the RAM is trivial. Justified only under a hard memory cap, where a miss must also cost >8.8µs. |
| 11 | When compression *is* enabled, the worker performs it | in the primary, synchronously | Distributes CPU across workers, shrinks IPC payloads, preserves `memcpy`-only propagation in the primary. Open: the primary's sweeper could instead compress cold entries in the background, keeping writes fast and recovering density only under pressure. |
| 12 | **Node-API, no V8 fast calls** | direct V8 with a vendored `v8-fast-api-calls.h` | The header is not shipped and `CFunction` is incomplete; the prize is ~6ns; Node-API's stable ABI removes the per-Node-major rebuild treadmill |
| 13 | Sizes computed at startup, then fixed | runtime-adaptive L2 | Growing L2 requires remapping in every live worker mid-read; a fixed mapping is the largest available simplification |
| 14 | Batched, fire-and-forget writes to the primary | synchronous write-through | Keeps `set()` off the IPC critical path; costs ~1 tick of cross-worker staleness |
| 15 | Current LTS, darwin + linux, x64 + arm64 | Windows in v1 | Windows needs `CreateFileMapping` — a second shared-memory implementation |
| 17 | **No background compaction** | async compress-on-the-threadpool with version-validated apply | Built and proven race-safe (18k stale captures correctly discarded, 0 wrong values), but worth only +1.9 points of hit rate at 3x read latency, while doubling the arena buys +6.9 points at no cost. Restricting to cold entries removes the latency penalty *and* the entire benefit. |
| 31 | **Modes are chosen by read/write ratio and type needs, not by a global default** | pick one mode for everyone | Measured across four dimensions: `direct` is lossless (18/18 types exact) and 2.8x faster than `primitives` when reads dominate, but 3.8x slower when writes do; `safe` silently converts 8 of 18 types but gives fresh mutable results and cheap writes; `primitives` never converts, refusing instead. All three are consistent L1-to-L2 and cross-process. |
| 30 | **Three named storage modes: `bytes`, `direct`, `safe`** | one mode with codec/freeze/isolate knobs | The knobs are still there, but the presets name the tradeoff being accepted. Measured, the ranking inverts by workload: `direct` 585k vs `safe` 433k when L1 hits dominate, and 175k vs 307k when writes and misses do, so neither is a default for everyone. `direct` carries one hole JS cannot close: typed-array contents cannot be frozen. |
| 29 | **BigInt accepted in primitives mode; rich types require the `v8.serialize` codec** | BigInt via text; JSON codec for everything | BigInt is a primitive and immutable, so excluding it was inconsistent; stored as sign byte plus 64-bit words for arbitrary precision. Date/Map/Set/TypedArray are rejected loudly by primitives mode and corrupted *silently* by JSON (Date to string, Map/Set to `{}`), so fidelity workloads must use the v8 codec. |
| 28 | **Value type is tagged in the entry, not inferred** | strings only; encode everything to text | L2 is read by other processes, so the type must travel with the bytes. Before this, numbers and booleans never reached the arena - they lived in L1 only, vanished on eviction and were invisible to other workers, while `get` looked correct until then. `null` threw outright. Doubles are stored as raw bytes: exact for `-0`, `NaN`, `Infinity` and subnormals, and no parsing. |
| 27 | **`structuredClone` rejected for per-read isolation; V8 serialization offered as a fidelity codec** | clone per read; JSON everywhere | Cloning per read is 2.0-2.4x slower than parsing the equivalent string and 1000x more than freezing, and Node 26 widens the gap. But JSON silently degrades eight common types (Date to string, Map/Set/RegExp to `{}`, NaN/Infinity to null, undefined dropped) and throws on cycles and BigInt, so a `v8.serialize` codec is offered for callers who need fidelity, at roughly 2-3x JSON's cost. |
| 26 | **Codec mode isolates on set and freezes by default** | adopt the caller's object; document a do-not-mutate contract; deep-copy on every get | `set` adopting the caller's object let a caller corrupt L1 without calling `get`, and the value then silently reverted when L1 evicted. Isolation costs one decode per set; freezing costs ~24% and turns a silent corruption into a `TypeError`. Freezing delivers the same guarantee as parse-per-read at roughly twice the throughput (813k vs 413k), differing in ergonomics: shared-immutable rather than fresh-mutable. |
| 25 | **A JSON replacer/space/reviver is never permitted; enforced, not documented** | rely on code review; document the rule only | A replacer costs 3.51x on Node 26 and indentation 2.11x, and an identity replacer produces byte-identical output so no output check can catch it. Enforced by a repo-wide balanced-paren lint plus a construction-time check on the caller-supplied codec, with `allowSlowCodec: true` as the deliberate escape hatch. |
| 24 | **ASCII values stored and returned as one-byte strings; non-ASCII as UTF-8** | latin1 for everything (previous behaviour) | Fixes silent mangling of non-ASCII, and keeps ASCII on the representation Node 26's 34%-faster stringify fast path favours. Node 26 penalises all-non-ASCII payloads 2.03x, worse in absolute terms than Node 24. |
| 23 | **`values: 'bytes'` is the default mode; codec is opt-in** | codec everywhere; JSON-always like bugsee; accept objects natively | Primitives make accounting exact (verified within 1% against measured heap), remove the aliasing hazard entirely, and need no codec. Costs ~20% for flattening plus exact sizing, and pushes object workloads onto a decode-per-hit path. Requires flattening on insert: a cached 1MB substring otherwise retains an 8MB parent. |
| 22 | **No per-object size measurement; a post-GC heap guard instead** | native structural size walk; `v8.serialize().length`; sampling `used_heap_size` directly | V8 exposes no per-object size outside a heap snapshot. A native walk was built and is -14% to -26% accurate against +/-7% for `encodedBytes x 3`, at 5825ns versus free. Bounding live heap after a GC bounds the thing that actually matters: retained heap 445MB to 121MB where the byte budget bound nothing. |
| 21 | **Optional caller-supplied codec; L1 caches decoded values, L2 stores bytes** | app owns the codec (L1 caches encoded strings); built-in JSON mode; accept the limitation | Resolves the decision 4/5 conflict by applying each at its own boundary. 3.6x on L1-resident object workloads, p50 1334ns to 42ns. Costs a documented aliasing contract (or 25-30% for `freeze: true`) and turns the L1 byte cap into a `heapFactor`-scaled estimate, measured at 2.79-3.21x for JSON-shaped objects. |
| 20 | **Arena sizing and `indexSlots` validated at create time** | trust the caller | A too-small segment underflowed into a hang; a non-power-of-two slot count breaks the probe mask |
| 19 | **Index slots hold the monotonic log position, not a physical offset** | physical offsets + seqlock alone | A seqlock cannot detect log reuse: once the head wraps over an evicted entry, its `seq` field is another record's payload. A monotonic position lets a reader prove liveness with `tailPub <= pos`. Closes a silent stale/torn-read bug. |
| 18 | **Reference bits live in a separate hints segment**, workers map it `O_RDWR` while the arena fd stays `O_RDONLY` | reference bit inside the entry | Workers do the reads but cannot write the arena, so in-entry bits were never set and second chance never fired. Isolation is preserved at descriptor level; a bad worker can only degrade eviction quality. |
| 17b | **Backward-shift deletion + 75% index load ceiling** | tombstones | Tombstones were never reclaimed, degrading probes to full-table scans at 3% load. Probe cost is now flat over 1M inserts. |
| 16 | **L2 data region is a circular log with second-chance re-append (`LOG2`)** | size-class slabs + CLOCK; plain FIFO log | Measured best hit rate in both realistic scenarios (+3.3 and +8.1 points over slab); zero external fragmentation; no slab calcification and no per-class rebalancing to build. Slab wins only a contrived size-oscillation case, and wins it *because* of calcification. |

---

## 13. What is still open

### Decisions that need a call

1. ~~**Atomic read-modify-write.**~~ **Done** — see §2. The shape settled as:
   `incr` returns the new value on the primary and queues a delta (returning
   `undefined`) in a worker; `cas` is primary-only and throws in a worker rather
   than returning an outcome it cannot know. Remaining wart: `incr`'s return type
   differs by process role, which only an async request/response path would fix.
2. ~~**Namespaces share one eviction budget.**~~ **Solved** — soft per-namespace
   quotas enforced through the eviction path, plus `clearNamespace()`. See §9.
   Remaining: the namespace table is a fixed 16 entries, and quotas are not
   validated against arena capacity, so over-committing them silently falls back
   to the budget cap for progress.
3. ~~**Ring capacity and second-chance budget are arbitrary.**~~ **Measured and
   set** — see §9. The ring is now derived from arena size as a ~100ms time
   budget; the second-chance budget is 16, where hit rate saturates at 8.

### Known limitations, accepted and documented

4. **Capacity is quantised to powers of two.** The log masks offsets with
   `dataBytes - 1`, so a 24MB, 26MB, 28MB or 32MB arena all yield exactly 16MB of
   data. Capacity can only be doubled, not tuned, which makes the §7 sizing
   formulas misleading. Fixable with a comparison instead of a mask on the
   allocation path.
5. **`direct` mode cannot protect typed-array contents** — JS offers no way to
   freeze them. Documented, asserted in `storage_modes_test.js`.
6. **The L1 byte budget is an estimate whenever a codec is in use**
   (`heapFactor`, measured at 2.79–3.21x but shape-dependent). The post-GC heap
   guard is the backstop, and it needs the event loop to turn.
7. **`safe` mode silently converts 8 of 18 types.** Inherent to JSON, not a bug,
   but it is the reason the mode is not the default.

### Unbuilt

8. ~~**Binary values.**~~ **Done** — `Buffer`, `TypedArray`, `ArrayBuffer` and
   `DataView` are stored as raw bytes under `FLAG_BINARY` and returned as a
   copied `Buffer`.
9. **The L3 (Valkey) seam.** Nothing exists. It is the reason the async method
   variants were reserved — and the reason a worker's `incr` cannot return a
   value, since there is no request/response path over IPC.
10. ~~**TTL sweeping.**~~ **Done** — the primary sweeps a slice of the index on a
    timer, sized so a full pass completes in a bounded time (a fixed slice
    covered only ~3% of a 1M-slot index per second). Reclaimed entries append to
    the invalidation ring so workers drop their L1 copies.
11. ~~**Primary-crash detection.**~~ **Done** — the primary stamps `heartbeatNs`
    on each maintenance tick; a worker whose drain sees a stale heartbeat sets
    `#primaryDead`, stops consulting L2 and serves L1 only. Still open: nothing
    *recovers* when a new primary appears; the worker stays degraded until
    restarted.
12. **Windows.** Needs `CreateFileMapping` — a second shared-memory
    implementation.

### Operational, still open

16. **Quotas are not validated against arena capacity.** Over-committing them
    silently falls back to the second-chance budget cap for progress rather than
    reporting the misconfiguration. The namespace table is also a fixed 16.
17. **No dead-code removal.** The rejected background-compaction machinery, the
    `SLAB` allocator that decision 16 did not choose, and the native size
    estimator that lost to `encodedBytes x 3` are all still compiled in, along
    with test-only hooks (`poke`, `suppressRefBit`, `backwardShift`,
    `clearHints`, `probe`) that sit on the same surface as `get` and `set`.
18. **`bytes` mode copies every string value on `set`.** `flatten` is
    unconditional because Node-API cannot tell a flat string from a slice, and a
    slice of any size can retain an arbitrarily large parent. That is the right
    default for correctness, but it is an allocation per write.

### Before anyone else could use this

13. ~~**TSAN has never been run.**~~ **Run** — see §9. It found and fixed a real
    race (non-atomic reference bits) and confirmed the deliberate seqlock
    payload race, which remains UB by the standard. `run_tsan.sh` is the gate.
    Still outstanding: TSAN cannot cover the cross-process case at all, so the
    multi-process evidence remains empirical.
14. **No packaging at all**: no `package.json`, no README, no CI, no prebuilds.
    The Node-API ABI check means one prebuild per platform would cover every
    Node major, but none is produced.
15. ~~**Two vendored-in-name-only dependencies.**~~ **Done.** LZ4 is now an
    optional build feature and the default build links nothing external;
    `prototype/vendor/rapidhash.h` is the upstream header verbatim (rapidhash V3,
    MIT, commit recorded in `vendor/README.md`) rather than a transcription.
    A checkout now builds with only a compiler and Node — verified by building
    from a clean export of the tree.

## 14. Assumptions

| Area | Assumption |
|---|---|
| L1 hit | ~21ns (measured, `Map` lookup) |
| L2 hit | **265ns @64B, 445ns @1KB** on a 200k-key random workload; 42–80ns only for a small in-order working set |
| `set` | 45ns @64B, 86ns @1KB, 620ns @16KB (**measured**, uncompressed) |
| Cross-worker write visibility | ~1 event-loop tick |
| Entry count | up to ~100k in L2 at typical value sizes |
| Worker count | up to 32 |
| Max key size | **1024 bytes** UTF-8; longer keys are rejected |
| Max value size | `min(dataBytes/2 - overhead, 4MB scratch)`, reported by `maxValueBytes()` |
| Durability | none — cache only; the arena dies with the primary |
| Security | uid-scoped, mode 0600; **any same-user process can read all cached data** |
| Maintenance | solo maintainer; one prebuild per platform, stable across Node majors |
