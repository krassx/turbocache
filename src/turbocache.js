'use strict';
// Thin JS layer over the L2 prototype, implementing the architecture in DESIGN.md:
//   L1  - per-worker JS Map with a byte budget (values are decoded strings)
//   L2  - shared arena; primary is the sole writer, workers map it read-only
//   writes - worker buffers, then batches to the primary over cluster IPC
//   coherence - workers drain the shared invalidation ring and drop stale L1 entries
const cluster = require('cluster');
const native = require('./native');
const fs = require('fs');
const v8 = require('v8');
const v8ser = require('v8');

// An unpaired surrogate encodes to U+FFFD in UTF-8, so '\uD800', '\uDC00' and
// '\uFFFD' all became ONE key in the arena and returned each other's values --
// the same aliasing class as the latin1 folding fixed earlier. Reject such keys
// at the boundary: the native layer refuses them too, but only this check can
// report it as `false` rather than as a silent miss or a shed ring write.
function hasLoneSurrogate(s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0xD800 || c > 0xDFFF) continue;
        if (c > 0xDBFF) return true;                       // lone low surrogate
        const n = s.charCodeAt(i + 1);
        if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;    // unpaired high surrogate
        i++;
    }
    return false;
}

// Mutating methods that bypass Object.freeze because they operate on internal
// slots rather than properties. Shadowed on frozen values so a mutation raises
// instead of silently corrupting the cached object. See deepFreeze.
const DATE_MUTATORS = ['setTime', 'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes',
    'setSeconds', 'setMilliseconds', 'setUTCFullYear', 'setUTCMonth', 'setUTCDate', 'setUTCHours',
    'setUTCMinutes', 'setUTCSeconds', 'setUTCMilliseconds', 'setYear'];
const MAP_MUTATORS = ['set', 'delete', 'clear'];
const SET_MUTATORS = ['add', 'delete', 'clear'];
function frozenMutator(name) {
    return function () {
        throw new TypeError(`Cannot call ${name}() on a frozen cached value ` +
            `(turbocache freeze:true). Copy it before mutating.`);
    };
}

// A single process-wide GC observer feeding every cache that wants the heap
// guard. See the constructor for why this is not per-instance.
// The heap guard needs the LIVE heap: a reading taken after a collection.
// used_heap_size sampled at an arbitrary moment includes uncollected garbage,
// so it rises when you shed and the guard thrashes (decision 22).
//
// A gc PerformanceObserver was the original signal. It is Node-only -- Bun and
// Deno accept the subscription and never emit an entry, so the guard was
// silently inert on both -- and it is less accurate than it looks, because it
// fires on scavenges too, which do not collect old space, so most of its
// samples are taken mid-garbage.
//
// A FinalizationRegistry callback runs only once its sentinel has actually been
// collected, so sampling there is a genuine post-collection reading, and it
// exists on all three runtimes. Measured against a known 42.7MB live set under
// heavy churn: observer mean 147.3MB, FinalizationRegistry mean 52.2MB.
//
// The spec promises nothing about whether or when finalizers run, so a floor
// poll backs it up: the minimum of a rolling window approximates the post-GC
// floor with no GC event at all (mean 85.3MB -- worse than the registry, far
// better than raw polling's 147.1MB, and available unconditionally).
const GC_POLL_MS = 1000;      // backstop cadence; unref'd, so it never holds the process open
const GC_WINDOW = 16;         // samples retained for the floor estimate
const GC_QUIET_MS = 5000;     // finalizers silent this long -> fall back to the floor
const GC_MIN_INTERVAL_MS = 500;   // debounce; see gcOnFinalizer
// -Infinity, not 0: monoMs() is performance.now(), which also starts near zero,
// so a 0 initialiser made the FIRST reading look like it arrived moments after a
// previous one and debounced it away. The guard then sat idle until the second
// collection, and at a long minInterval it could stay idle for a long time.
let gcRegistry = null, gcTimer = null, gcLastSignal = -Infinity, gcLastEval = -Infinity;
let gcMinInterval = GC_MIN_INTERVAL_MS;
let gcEvals = 0, gcDebounced = 0;
const gcSubscribers = new Set();
const gcWindow = [];

function gcArm() {
    // The sentinel is unreachable the moment this returns, so the next
    // collection finalizes it and re-arms the signal.
    if (gcRegistry) { try { gcRegistry.register({}, 1); } catch { /* registry unusable */ } }
}

// How often the guard is willing to LOOK, independent of how often the runtime
// happens to collect. Collection frequency is the runtime's business and varies
// by more than 4x across them under identical churn: 6.3/s on Node, 9.7/s on
// Bun, 28.6/s on Deno. Two reasons not to follow it:
//
//   - the sample is not free, and on Bun 1.4.2 it is expensive out of all
//     proportion: v8.getHeapStatistics() is ~110ns and constant-time on Node,
//     but O(heap) on Bun -- 3.2ms at a 17MB heap rising to 74ms at 411MB.
//     Reported upstream and being fixed (oven-sh/bun#30596, unmerged as of
//     2026-09-10), so treat that figure as dated rather than permanent.
//   - shedding is not free either, and this reason does not expire. Acting 28
//     times a second churns L1 far harder than a memory guard needs to, on
//     every runtime.
//
// So the debounce stays even once Bun's sampling cost is fixed: it was never
// only about that.
//
// A guard acts on a timescale of seconds, so 500ms is ample. The registry is
// re-armed on EVERY callback regardless: dropping a sample must never drop the
// signal, or the chain stops and the guard goes quiet permanently.
function gcOnFinalizer() {
    gcArm();                                   // first and unconditional
    const now = monoMs();
    if (now - gcLastEval < gcMinInterval) { gcDebounced++; return; }
    gcLastEval = now;
    gcLastSignal = now;
    gcEvals++;
    // Canonical source. process.memoryUsage().heapUsed is far cheaper and equals
    // it exactly on Node and Deno (ratio 1.000), but on Bun it tracks something
    // else - it stayed flat at 9.4MB while used_heap_size grew - and Bun's
    // heap_size_limit is not constant either (318MB -> 644MB as the heap grew),
    // so neither the numerator nor the denominator can be shortcut.
    const h = v8.getHeapStatistics();
    gcWindow.length = 0;                       // a real post-GC reading supersedes the floor
    gcNotify(h.used_heap_size, h.heap_size_limit);
}

function gcNotify(used, limit) {
    for (const c of gcSubscribers) c._onGc(used, limit);
}

function gcSubscribe(inst, minIntervalMs) {
    const first = gcSubscribers.size === 0;
    gcSubscribers.add(inst);
    // The signal is process-wide but the cadence is per-caller, so the most
    // eager subscriber sets the pace for everyone.
    if (typeof minIntervalMs === 'number' && minIntervalMs >= 0) {
        gcMinInterval = first ? minIntervalMs : Math.min(gcMinInterval, minIntervalMs);
    }
    if (gcTimer) return;                       // already running for this process
    if (typeof FinalizationRegistry === 'function') {
        gcRegistry = new FinalizationRegistry(gcOnFinalizer);
        gcArm();
    }
    gcTimer = setInterval(() => {
        const h = v8.getHeapStatistics();
        gcWindow.push(h.used_heap_size);
        if (gcWindow.length > GC_WINDOW) gcWindow.shift();
        // While the registry is delivering, its readings are strictly better;
        // the floor only takes over once finalizers go quiet.
        if (gcRegistry && monoMs() - gcLastSignal < GC_QUIET_MS) return;
        if (!gcWindow.length) return;
        gcLastEval = monoMs(); gcEvals++;
        gcNotify(Math.min(...gcWindow), h.heap_size_limit);
    }, GC_POLL_MS);
    if (gcTimer.unref) gcTimer.unref();
}

function gcUnsubscribe(inst) {
    gcSubscribers.delete(inst);
    if (gcSubscribers.size) return;
    if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
    gcRegistry = null;                         // drops any pending registration with it
    gcWindow.length = 0;
    gcLastSignal = -Infinity; gcLastEval = -Infinity;
    gcMinInterval = GC_MIN_INTERVAL_MS;
}

// Observable pace, so a caller can see the guard is alive and how often it is
// actually looking - rather than how often the runtime happens to collect.
function gcPace() { return { evaluations: gcEvals, debounced: gcDebounced, minIntervalMs: gcMinInterval }; }

// L1 expiry runs on a MONOTONIC clock, matching the arena's tick-based epoch.
// With Date.now() an NTP step moved L1 and L2 expiry in opposite directions:
// a backward step made L1 entries immortal while L2 expired them on schedule,
// and a forward step did the reverse. performance.now() measured 21.5ns against
// Date.now()'s 23.7ns, so correctness here is free.
const { performance } = require('perf_hooks');
const monoMs = () => performance.now();

const MSG = 'tc';
const RING_MSG = 'tcr';   // doorbell only: 'your submission rings are non-empty'
// Max second-chance reprieves per L1 insert. Matches the arena's budget in
// store_ops.h; see the eviction loop for why an unbounded value is O(n).
const L1_SECOND_CHANCE_BUDGET = 16;
let storeReady = false;
let submitName = null;    // primary: the segment it created, null = IPC transport
let submitReady = null;   // worker: the segment name it successfully opened
let attachedName = null;  // worker: the arena name, so it can re-attach after a primary death
let isPrimaryProcess = false;   // set by createPrimary; guards the id-0 write path
const installedWorkers = new WeakSet();   // workers already wired by install()      // the native store is a per-process singleton
const instances = new Set();  // live caches in THIS process, for local invalidation

class TurboCache {
    #l1 = new Map();          // key -> { v, bytes, hits }
    #byHash = new Map();      // hash hex -> key   (ring records carry hashes)
    #l1Bytes = 0;
    #l1Iter = null;
    #ringIdx = -1;            // shared-memory submission ring, -1 = use IPC
    #ringMaxValue = 0;        // largest value one ring record can carry
    #transportOpt = 'shm';
    #pendingDel = new Set();  // keys this worker deleted but the primary has not applied yet
    #pendingDelHash = new Map();   // hash -> key, so the invalidation record can clear it:
                                   // #l1Drop already removed the #byHash entry, so without this
                                   // a deleted key stayed suppressed even after another worker
                                   // recreated it
    #doorbellPending = false;           // retained FIFO cursor into #l1; see #oldestEntry
    #l1Max;
    #outbox = [];
    #outboxBytes = 0;
    #outboxMaxBytes = 1 << 20;      // flush eagerly past this, bounding worker memory
    #inFlightBytes = 0;       // bytes handed to process.send and not yet drained
    #maxInFlightBytes = 8 << 20;
    #flushScheduled = false;
    #cursor = 0;
    #ns = '';
    #nsId = 0;
    #maxValue = 0;
    #timer = null;
    #sweepCursor = 0;
    #drainTicks = 0;
    #lastStaleCheck = 0;
    #staleMs = 5000;
    #primaryDead = false;
    #keyMax = 1024;
    // Native expiry is milliseconds from the arena's creation time.
    #id;
    #codec;
    #l1Decoded = true;
    #isolate = true;
    #noCodec = false;
    #freeze;
    #heapFactor;
    #guardMax = 0; #guardShed = 0.25; #gcObserver = null; liveHeapFraction = 0;
    #attached = false;
    stats = { l1Hits: 0, l2Hits: 0, misses: 0, sets: 0, deletes: 0, invalidated: 0,
              flushes: 0, sent: 0, rejectedType: 0, rejectedSize: 0 };
    lastError = null;

    // Resolves the decision 4 / decision 5 tension. L2 still stores bytes only
    // (decision 4 holds at the wire and arena boundary). But when a codec is
    // supplied, L1 holds the DECODED value, so an L1 hit skips decoding
    // entirely - which is what decision 5 was actually for. Without a codec the
    // value is already opaque bytes and L1 is optimal as-is.
    constructor(opts = {}) {
        // A namespace is a key prefix AND an arena-level identity, so it can
        // carry a byte quota that eviction respects.
        const nsOpt = typeof opts.namespace === 'string' ? { name: opts.namespace } : opts.namespace;
        if (nsOpt && nsOpt.name) {
            this.#ns = nsOpt.name + ':';
            // #id is assigned further down, so read the option directly: only the
            // primary may register a namespace; a worker must find it already there.
            this.#nsId = native.nsResolve(nsOpt.name, nsOpt.quotaBytes || 0, (opts.workerId || 0) === 0);
            if (this.#nsId === -2)
                throw new Error(`namespace name must be under 24 bytes, got ${Buffer.byteLength(nsOpt.name)}`);
            if (this.#nsId < 0)
                throw new Error(this.#id === 0
                    ? 'namespace table full (15 named namespaces max)'
                    : `namespace '${nsOpt.name}' was not registered by the primary`);
        }
        this.#maxValue = native.maxValueBytes();
        this.#keyMax = native.keyMaxBytes();
        instances.add(this);
        this.#l1Max = opts.l1MaxBytes ?? (2 * 1024 * 1024);
        this.#outboxMaxBytes = opts.outboxMaxBytes ?? (1 << 20);
        // `??` not `||`: 0 is a meaningful value (send nothing) and a test that
        // passed 0 to disable sending silently got the 8MB default instead,
        // making a control phase identical to the phase it was controlling.
        this.#maxInFlightBytes = opts.maxInFlightBytes ?? (8 << 20);
        this.#staleMs = opts.primaryStaleMs || 5000;
        // `|| 0` also mapped an explicit 0 to the primary role. That is only
        // legitimate in the process that actually created the arena.
        this.#id = opts.workerId ?? 0;
        if (this.#id === 0 && opts.attached !== false && !isPrimaryProcess)
            throw new Error('turbocache: workerId 0 is the primary; a worker must use ' +
                            'attachWorker() or open() so cluster assigns its id');
        this.#attached = opts.attached !== false;
        this.#transportOpt = opts.transport || 'shm';
        // 'primitives' mode: accept only string/number/boolean/null. Buys three
        // things the codec mode cannot: byte accounting that is exact rather
        // than a heapFactor estimate, no aliasing hazard (primitives are
        // immutable), and no codec to configure. Costs the caller a decode on
        // every L1 hit if its values are really objects.
        // Storage modes. Each names the tradeoff it accepts:
        //
        //   bytes      - NO CODEC. The native layer encodes the value directly:
        //                 scalars become their byte representation, binary is
        //                 stored verbatim. Anything needing a codec is rejected
        //                 LOUDLY. Exact byte accounting, no aliasing.
        //                 ('primitives' is accepted as a legacy alias, but the
        //                 mode never accepted only primitives once decision 4's
        //                 Buffer/TypedArray values were honoured - bytes are the
        //                 most directly storable thing there is, and routing
        //                 them through a codec costs 5.3x on write, 3.9x on read.)
        //   direct     - value stored as-is with full JS type fidelity
        //                (v8 structured serialization). One serialize +
        //                deserialize per write; reads are free because L1 hands
        //                back the frozen decoded object. Mutation throws.
        //   safe       - everything through JSON. Every read parses, so callers
        //                get a fresh mutable object and cannot corrupt anything.
        //                Cheap writes, and JSON's silent type conversions apply:
        //                Date becomes a string, Map/Set become {}.
        const preset = opts.storage;
        if (preset === 'direct') {
            opts = { isolate: true, freeze: true, ...opts,
                     codec: opts.codec || TurboCache.V8_CODEC };
        } else if (preset === 'safe') {
            opts = { ...opts, codec: opts.codec || TurboCache.JSON_CODEC, l1Decoded: false };
        } else if (preset === 'bytes' || preset === 'primitives') {
            opts = { ...opts, values: 'bytes' };
        }
        this.storage = preset === 'primitives' ? 'bytes'
            : (preset || (opts.codec ? 'codec' : 'bytes'));
        // safe mode keeps the ENCODED form in L1 and decodes on every read, so
        // each caller gets its own object. direct keeps the decoded object.
        this.#l1Decoded = opts.l1Decoded !== false;
        this.#noCodec = opts.values === 'bytes' || opts.values === 'primitives';
        this.#codec = this.#noCodec ? null : (opts.codec || null);
        if (this.#codec && opts.allowSlowCodec !== true) TurboCache.assertFastCodec(this.#codec);
        // Safe by default, fast by choice. Without freeze, mutating what get()
        // returned silently corrupts L1 for this worker until eviction, at
        // which point the value reverts to L2's copy - a bug that appears and
        // disappears on its own. Measured: freeze delivers the same
        // immutability guarantee as re-parsing on every get (the bugsee
        // approach) at roughly twice the throughput, 813k vs 413k ops/s.
        this.#freeze = opts.freeze !== false;
        // set() otherwise adopts the caller's own object into L1. Mutating a
        // variable they still hold then corrupts the cache without any call to
        // get(), and the value silently reverts when L1 evicts and L2's
        // pre-mutation bytes come back. Decoding our own encoding costs one
        // parse per set and gives L1 an object the caller has never seen.
        this.#isolate = opts.isolate !== false;
        // A decoded object costs several times its encoded size on the V8 heap,
        // and JS cannot measure that. The budget is in encoded bytes scaled by
        // this factor; it is an estimate, not a guarantee.
        this.#heapFactor = (this.#noCodec || !this.#l1Decoded) ? 1
            : (opts.heapFactor || (this.#codec ? 3 : 1));
        // Per-object size cannot be measured: V8 exposes no such API, and a
        // structural estimate is both less accurate than encodedBytes*3 and far
        // more expensive. So do not try. Bound the thing that actually matters -
        // LIVE heap - instead.
        //
        // used_heap_size sampled at an arbitrary moment includes uncollected
        // garbage, so it rises when you shed and the guard thrashes. Read it
        // immediately after a major GC instead, where it is the live set.
        const g = opts.heapGuard;
        if (g !== false) {
            this.#guardMax = (g && g.maxHeapFraction) || 0.80;
            this.#guardShed = (g && g.shedFraction) || 0.25;
            // ONE observer per process, not one per cache. Each instance used to
            // register its own, so an application that opens caches without
            // closing them accumulated observers as well as instances: 20k opens
            // cost ~24MB. The guard is a process-wide signal; the per-instance
            // part is only the thresholds.
            this.#gcObserver = true;
            gcSubscribe(this, g && g.minIntervalMs);
        }
    }

    // A JSON codec MUST call JSON.stringify/parse with no second argument.
    // Measured on Node 26: a replacer costs 3.51x and 2-space indent 2.11x,
    // because Node 26 sped up the fast path (34%) without speeding up the slow
    // ones - so falling off is worse now than it was on Node 24.
    //
    // The codec comes from the caller, so a source-level lint cannot see it.
    // Probe it instead: if it emits something JSON-shaped that is not byte-
    // identical to canonical JSON.stringify, it is on a slow path. Codecs that
    // are not JSON at all (msgpack, protobuf) do not emit a leading '{' and are
    // left alone. Opt out with allowSlowCodec: true.
    // Counts top-level arguments of each `name(...)` call in `src`, using
    // balanced-paren scanning so nested calls and object literals do not
    // confuse it the way a regex would.
    static callArgCounts(src, name) {
        const out = [];
        let i = 0;
        while ((i = src.indexOf(name + '(', i)) !== -1) {
            let d = 0, args = 1, j = i + name.length, empty = true;
            for (; j < src.length; j++) {
                const c = src[j];
                if (c === '(' || c === '[' || c === '{') d++;
                else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) break; }
                else if (c === ',' && d === 1) args++;
                else if (d === 1 && !/\s/.test(c)) empty = false;
            }
            out.push({ index: i, args: empty ? 0 : args, text: src.slice(i, j + 1) });
            i = j + 1;
        }
        return out;
    }

    static assertFastCodec(codec) {
        // An identity replacer - JSON.stringify(v, (k, x) => x) - produces
        // byte-identical output, so probing cannot see it, yet it still costs
        // 3.51x. Read the function source instead. Native or bound functions
        // report [native code] and are left alone.
        for (const [which, fn] of [['encode', codec.encode], ['decode', codec.decode]]) {
            let src = '';
            try { src = Function.prototype.toString.call(fn); } catch { continue; }
            if (src.includes('[native code]')) continue;
            const name = which === 'encode' ? 'JSON.stringify' : 'JSON.parse';
            for (const call of TurboCache.callArgCounts(src, name)) {
                if (call.args > 1) {
                    throw new Error(
                        `codec.${which} is not on V8's JSON fast path: ${call.text.slice(0, 60)} ` +
                        `passes ${call.args} arguments. ${name} must take exactly one ` +
                        `(a replacer costs 3.51x and indentation 2.11x on Node 26). ` +
                        `Pass allowSlowCodec: true to override.`);
                }
            }
        }

        const probe = { b: 1, a: 'x', n: [1, 2] };
        let enc;
        try { enc = codec.encode(probe); } catch { return; }
        if (typeof enc !== 'string' || enc[0] !== '{') return;   // not a JSON codec
        const canonical = JSON.stringify(probe);
        if (enc === canonical) return;
        const why = /\n|\n\s/.test(enc) || /: /.test(enc)
            ? 'it indents or spaces its output'
            : 'it filters or reorders keys';
        throw new Error(
            `codec.encode is not on V8's JSON fast path: ${why}. ` +
            `Use JSON.stringify(value) with no replacer and no space argument ` +
            `(a replacer costs 3.51x and indentation 2.11x on Node 26). ` +
            `Pass allowSlowCodec: true to override.`);
    }

    static get JSON_CODEC() { return { encode: JSON.stringify, decode: JSON.parse }; }
    static get V8_CODEC() {
        return { encode: v => v8ser.serialize(v).toString('latin1'),
                 decode: s => v8ser.deserialize(Buffer.from(s, 'latin1')) };
    }

    // KNOWN HOLE: Object.freeze throws on an ArrayBuffer view with elements,
    // and JS offers no way to make one immutable (ArrayBuffer
    // transferToImmutable does not exist in Node 24 or 26). So in 'direct' mode
    // the object graph is frozen but typed-array CONTENTS stay writable, and a
    // caller that writes into one corrupts L1 for its own process until the
    // entry is evicted, at which point the arena's copy comes back. Values
    // holding typed arrays want 'safe' mode, or a defensive copy by the caller.
    static deepFreeze(o) {
        if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
        if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) return o;   // cannot be frozen
        // Object.freeze does not seal INTERNAL SLOTS, so a "frozen" Date, Map or
        // Set still mutates through its own methods: d.setTime(0), m.set(k, v)
        // and s.add(x) all succeeded and corrupted L1 until the entry was
        // evicted. The whole point of freeze is to turn silent corruption into a
        // TypeError, so shadow those mutators with throwing own-properties
        // BEFORE freezing (afterwards the object is non-configurable).
        const mutators = o instanceof Date ? DATE_MUTATORS
                       : o instanceof Map ? MAP_MUTATORS
                       : o instanceof Set ? SET_MUTATORS : null;
        if (mutators) {
            for (const m of mutators) {
                if (typeof o[m] !== 'function') continue;
                Object.defineProperty(o, m, { value: frozenMutator(m), writable: false, configurable: false, enumerable: false });
            }
        }
        Object.freeze(o);
        for (const k in o) TurboCache.deepFreeze(o[k]);
        return o;
    }

    // --- lifecycle -------------------------------------------------------
    // Sizing per DESIGN.md section 7, computed once at startup.
    static autoSize() {
        const os = require('os'), v8m = require('v8');
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const arena = clamp(Math.floor(os.totalmem() * 0.01), 16 << 20, 128 << 20);
        const l1 = clamp(Math.floor(v8m.getHeapStatistics().heap_size_limit * 0.005), 512 * 1024, 2 << 20);
        // One index slot per ~512 bytes of arena, kept under the 75% load
        // ceiling and rounded up to a power of two for the probe mask.
        let slots = 1 << Math.ceil(Math.log2(Math.max(1024, (arena / 512) / 0.75)));
        return { arenaBytes: arena, l1MaxBytes: l1, indexSlots: Math.min(slots, 1 << 22) };
    }

    // The ordinary entry point: figures out on its own whether this process is
    // the primary (create the arena) or a worker (attach to it), and sizes
    // everything from the machine. createPrimary/attachWorker remain for tests
    // and for callers that want to pin the numbers.
    // Second and later calls in the same process bind another namespace to the
    // arena this process already created or attached, rather than trying to
    // create it again. Several namespaces in one process is a normal thing to
    // want and there was previously no way to express it.
    static open(opts = {}) {
        const cluster = require('cluster');
        if (storeReady) {
            // The caller's opts used to be spread AFTER the computed id, so
            // `open({workerId: 0})` in a worker produced a cache that believed it
            // was the primary and took the primary's WRITE path against a
            // read-only mapping -- a SIGBUS on the first set(), not a wedge.
            const id = cluster.isWorker ? cluster.worker.id : 0;
            if (cluster.isWorker && opts.workerId !== undefined && opts.workerId !== id)
                throw new Error(`turbocache: workerId is assigned by cluster in a worker (${id}); ` +
                                `refusing the supplied ${JSON.stringify(opts.workerId)}`);
            const c = new TurboCache({ ...opts, workerId: id });
            // A second cache opened in a worker used to skip the ring entirely and
            // silently run on the slower IPC transport.
            if (cluster.isWorker && submitReady && opts.transport !== 'ipc') c.useSubmissionRing(submitReady);
            return c;
        }
        const auto = TurboCache.autoSize();
        const arenaBytes = opts.arenaBytes || auto.arenaBytes;
        const indexSlots = opts.indexSlots || auto.indexSlots;
        const o = { l1MaxBytes: auto.l1MaxBytes, ...opts };
        if (cluster.isWorker) {
            // A worker forked BEFORE the primary called open() has no
            // TURBOCACHE_ARENA, and used to fall through to createPrimary -
            // silently creating a second writable arena and shm_unlinking the
            // primary's. Fail loudly instead.
            if (!process.env.TURBOCACHE_ARENA)
                throw new Error('turbocache: no arena to attach to. The primary must call ' +
                                'Cache.open()/new Cache() BEFORE forking workers.');
            return TurboCache.attachWorker(process.env.TURBOCACHE_ARENA, cluster.worker.id, o);
        }
        // A pid-based name leaks: create() unlinks any prior segment, but a
        // crashed run's segment has a name nothing will ever reuse, so it
        // survives until reboot. Deriving the name from the application's
        // identity instead means a restart reclaims its own segment, while two
        // different apps on one host still get different ones.
        const name = opts.name || TurboCache.defaultName();
        process.env.TURBOCACHE_ARENA = name;      // inherited by workers forked later
        return TurboCache.createPrimary(name, arenaBytes, indexSlots, o);
    }

    // Wire the primary's side of the worker write path. Without this, worker
    // writes never reach L2.
    // Stable per-application shm name, <= 31 chars for darwin's SHM_NAME_MAX.
    // A create() failure is nearly always the backing filesystem being too small
    // rather than anything about the arena itself. On Linux that is /dev/shm,
    // which containers default to 64MB -- so say so instead of "create failed".
    static #createError(arenaBytes) {
        let hint = '';
        if (process.platform === 'linux') {
            try {
                const st = fs.statfsSync('/dev/shm');
                const total = st.blocks * st.bsize;
                const free = st.bfree * st.bsize;
                if (total < arenaBytes || free < arenaBytes) {
                    const mb = (n) => `${Math.round(n / (1 << 20))}MB`;
                    hint = ` -- /dev/shm holds ${mb(total)} (${mb(free)} free) but the arena needs ` +
                           `${mb(arenaBytes)}. In Docker pass --shm-size=${mb(arenaBytes * 2)}, ` +
                           `or lower the l2Bytes option.`;
                }
            } catch { /* statfs is best-effort; fall back to the bare message */ }
        }
        return `arena create failed${hint}`;
    }

    static defaultName() {
        const crypto = require('crypto');
        const id = (process.argv[1] || process.cwd()) + '|' + (process.env.TURBOCACHE_ID || '');
        return '/tc-' + crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
    }

    // Attaches exactly once per worker. Calling this between fork() and the
    // 'online' event previously attached twice, applying every batch twice.
    static install(cluster) {
        // Module-level, not per-call: two install() calls each built their own
        // WeakSet, so both attached a listener to the same worker and every
        // batch was applied twice (one incr became two).
        const wired = installedWorkers;
        const attach = w => {
            if (!w || wired.has(w)) return;
            wired.add(w);
            w.on('message', m => {
                if (m && m.t === RING_MSG) { TurboCache.drainSubmissions(); return; }
                if (TurboCache.isCacheMessage(m)) TurboCache.applyBatch(m);
            });
        };
        cluster.on('online', attach);
        cluster.on('fork', attach);
        for (const id in cluster.workers) attach(cluster.workers[id]);
    }

    // Drain the submission rings, then keep draining while work remains. Bounded
    // per turn on purpose: draining is synchronous work on the primary's event
    // loop, so an unbounded drain would just move the stall from the worker to
    // the primary -- which is the whole thing this replaces.
    static drainSubmissions(budget = 4096) {
        if (!submitName && !storeReady) return 0;
        let n = 0;
        try { n = native.submitDrain(budget); } catch { return 0; }
        // The primary's OWN L1 must follow the writes it just applied, exactly as
        // applyBatch does for the IPC path. Without this the primary served stale
        // values indefinitely after any worker write -- and the regression test
        // that was supposed to catch it drove applyBatch directly, so it passed
        // while the default path regressed underneath it.
        if (n > 0) TurboCache.#primaryInvalidate();
        if (n >= budget && !TurboCache.#drainScheduled) {
            TurboCache.#drainScheduled = true;
            setImmediate(() => { TurboCache.#drainScheduled = false; TurboCache.drainSubmissions(budget); });
        }
        return n;
    }
    static #drainScheduled = false;

    // Drain the arena's invalidation ring on the PRIMARY. Records carry the
    // writerId that produced them, so entries the primary wrote itself are
    // skipped: its L1 is already correct for those, and dropping them would make
    // its own cache useless for every key it writes.
    static #primaryCursor = 0;
    static #primaryInvalidate() {
        for (let round = 0; round < 64; round++) {
            let r;
            try { r = native.ringRead(TurboCache.#primaryCursor, 1024); } catch { return; }
            if (!r) return;                        // store detached underneath us
            if (r.wrapped) {                       // fell too far behind: flush wholesale
                for (const c of instances) c.clearLocal();
                TurboCache.#primaryCursor = r.head;
                return;
            }
            const n = r.hashes.length;
            for (let i = 0; i < n; i++) {
                if (r.hashes[i] === 'ffffffffffffffff') { for (const c of instances) c.clearLocal(); continue; }
                if (r.writers[i] === 0) continue;  // our own write
                for (const c of instances) c._dropByHash(r.hashes[i]);
            }
            TurboCache.#primaryCursor = r.head;
            if (n < 1024) return;                  // caught up
        }
    }

    _onGc(used, limit) { this.#onGc(used, limit); }

    _dropByHash(hash) {
        const k = this.#byHash.get(hash);
        if (k !== undefined) { this.#l1Drop(k); this.#byHash.delete(hash); this.stats.invalidated++; }
    }

    // --- primary death and recovery --------------------------------------
    //
    // A worker whose primary died used to degrade to L1-only PERMANENTLY, even
    // once a new primary was running. Two things force the shape of the fix:
    //
    //   1. A new primary is a NEW SEGMENT. create() unlinks and re-creates, so
    //      the mapping a degraded worker still holds is an orphan that will
    //      never receive another update. Detecting a new primary therefore means
    //      re-opening BY NAME, not watching the header we already hold.
    //   2. The worker must let go FIRST. On Windows CreateFileMappingA fails
    //      with ERROR_ALREADY_EXISTS while any process holds a handle, so a
    //      worker clinging to a dead arena prevents a new primary from ever
    //      starting. Detaching is mandatory, not hygiene - and free, since a
    //      degraded worker serves L1 only and never touches the arena.
    //
    // State is on the CLASS, not the instance: `native` is process-global, so
    // one detach/attach drives every cache in the process.
    static #degraded = false;
    static #recoverTimer = null;
    static #lastHb = -1;

    static #degrade(age) {
        if (TurboCache.#degraded || isPrimaryProcess) return;
        TurboCache.#degraded = true;
        for (const c of instances) {
            c._setDead(true, `primary heartbeat is ${age < 0 ? 'in the future' : age + 'ms old'}; serving L1 only`);
        }
        // Give the ring slot back before unmapping, or it stays owned by this pid
        // in a segment nobody will reclaim.
        try { native.submitRelease(); } catch { /* not using the ring */ }
        try { native.submitDestroy(); } catch { /* not created */ }
        submitReady = null;
        try { native.detach(); } catch { /* already gone */ }
        storeReady = false;
        TurboCache.#lastHb = -1;
        if (TurboCache.#recoverTimer || !attachedName) return;
        TurboCache.#recoverTimer = setInterval(() => TurboCache.#tryRecover(), 1000);
        if (TurboCache.#recoverTimer.unref) TurboCache.#recoverTimer.unref();
    }

    static #tryRecover() {
        if (!attachedName) return;
        if (!native.attach(attachedName)) return;              // no primary yet
        // A plausible age proves nothing: a dead primary's last stamp still looks
        // recent until staleMs elapses, and a freshly created arena starts with a
        // fresh one. Require the heartbeat to ADVANCE between two polls, which
        // only a live writer can do. The primary stamps every 500ms, so a healthy
        // one passes within two ticks.
        const hb = native.heartbeatRaw();
        const age = native.heartbeatAgeMs();
        if (hb === TurboCache.#lastHb || age < 0 || age > TurboCache.#staleMsFor()) {
            TurboCache.#lastHb = hb;
            try { native.detach(); } catch {}
            storeReady = false;
            return;
        }
        clearInterval(TurboCache.#recoverTimer);
        TurboCache.#recoverTimer = null;
        TurboCache.#degraded = false;
        storeReady = true;
        const id = native.arenaId();
        const sameArena = TurboCache.#arenaId !== null && id === TurboCache.#arenaId;
        TurboCache.#arenaId = id;
        for (const c of instances) c._recovered(sameArena);
    }

    // Half the staleness budget, so "alive" is a stricter test than "dead" was.
    // The asymmetry is what stops a primary that stalls periodically from
    // flapping every worker's L1 back and forth.
    static #staleMsFor() {
        for (const c of instances) return c._staleMs() / 2;
        return 2500;
    }
    static #arenaId = null;

    _setDead(dead, msg) {
        this.#primaryDead = dead;
        if (msg) this.lastError = msg;
    }
    _staleMs() { return this.#staleMs; }
    _recovered(sameArena) {
        // Everything this worker believed about the arena is now suspect: it
        // missed every invalidation while detached, and an unapplied delete is a
        // lost write rather than a pending one.
        this.clearLocal();
        this.#cursor = native.ringHead();      // not 0: replaying a ring we already flushed for is waste
        this.#ringIdx = -1;
        if (this.#transportOpt !== 'ipc' && attachedName) this.useSubmissionRing(attachedName + '_sub');
        this.#primaryDead = false;
        this.lastError = null;
        this.stats.recoveries = (this.stats.recoveries || 0) + 1;
        this.stats.lastRecovery = { sameArena, at: Date.now() };
    }

    /** Guard cadence: evaluations performed, finalizer signals dropped by the
     *  debounce, and the interval in force. */
    static heapGuardPace() { return gcPace(); }

    static submitStats() { try { return native.submitStats(); } catch { return null; } }

    static createPrimary(name, arenaBytes, indexSlots, opts = {}) {
        if (!native.create(name, arenaBytes, indexSlots, 2)) throw new Error(TurboCache.#createError(arenaBytes));
        // Compression is off unless the caller explicitly asks AND the addon was
        // built with LZ4. Measured a bad trade (see DESIGN.md), so it is neither
        // the default nor a build dependency.
        if (opts.compress === true) {
            if (!native.hasLz4())
                throw new Error('turbocache: compress:true requires an addon built with ' +
                                'LZ4 (node-gyp configure build --turbocache_lz4=1)');
            native.setCompressMin(opts.compressMinBytes || 1024, opts.compressAccel || 1);
        } else {
            native.setCompressMin(1 << 30, 1);          // effectively never
        }
        storeReady = true;
        isPrimaryProcess = true;
        // Submission rings. One per worker slot; a worker claims a slot by CAS on
        // the ring's owner field, so slots are ASSIGNED rather than passed in --
        // which makes a worker/primary id collision structurally impossible
        // instead of merely rejected.
        if (opts.transport !== 'ipc') {
            const rings = opts.submitRings || 32;
            const ringBytes = opts.submitRingBytes || (1 << 20);
            if (!native.submitCreate(name + '_sub', rings, ringBytes))
                throw new Error('turbocache: submission ring segment could not be created');
            submitName = name + '_sub';
        }
        const c = new TurboCache({ ...opts, workerId: 0 });
        c._startMaintenance(opts);
        return c;
    }
    static attachWorker(name, workerId, opts = {}) {
        // Worker ids must be >= 1. `#id === 0` is how every method recognises the
        // primary, so a worker attached as 0 takes the primary's WRITE path and
        // calls into the native writer against a read-only mapping. That does not
        // throw and does not crash -- it wedges the process permanently on the
        // first set(), with the event loop blocked and no diagnostic. Zero-based
        // worker ids are the natural thing for a caller to write, so this has to
        // be a loud error rather than a documented footnote.
        // Coerce numeric strings: ids routinely arrive from environment
        // variables. Everything else must already be a positive integer.
        const wid = (typeof workerId === 'string' && /^[0-9]+$/.test(workerId)) ? Number(workerId) : workerId;
        if (!Number.isInteger(wid) || wid < 1)
            throw new Error(`workerId must be an integer >= 1 (0 is reserved for the primary), got ${JSON.stringify(workerId)}`);
        if (!native.attach(name)) throw new Error('arena attach failed');
        storeReady = true;
        attachedName = name;
        const c = new TurboCache({ ...opts, workerId: wid });
        if (opts.transport !== 'ipc') c.useSubmissionRing(name + '_sub');
        return c;
    }

    // --- L1 --------------------------------------------------------------
    #l1Put(key, v, hash, encodedLen, expiresAt = 0) {
        // In primitives mode the cost is known exactly; otherwise it is the
        // encoded length scaled by heapFactor, which is only an estimate.
        const bytes = this.#noCodec
            ? native.primBytes(v) + native.primBytes(key) + 64
            : (key.length + encodedLen + 64) * this.#heapFactor;
        const prev = this.#l1.get(key);
        if (prev) this.#l1Bytes -= prev.bytes;
        this.#l1.set(key, { v, bytes, hits: 1, exp: expiresAt, hash });
        this.#byHash.set(hash, key);
        this.#l1Bytes += bytes;

        // FIFO with second chance: Map preserves insertion order, so the oldest
        // entry is first. An entry that has been read again gets one reprieve.
        //
        // The reprieve MUST be budgeted. A re-queue does not free any bytes, so
        // it does not advance the loop condition: on a workload where most
        // residents have been re-read, one insert walks the entire map putting
        // every entry to the back before it can evict anything. Measured O(n) in
        // L1 entry count -- 3141ns at 2MB, 8257ns at 8MB, 23545ns at 32MB, then
        // 464ns at 128MB where the set fits and eviction never runs. The native
        // arena bounds its equivalent loop (store_ops.h g_secondChanceBudget);
        // this one did not. Past the budget an entry is evicted despite its bit.
        let reprieves = L1_SECOND_CHANCE_BUDGET;
        while (this.#l1Bytes > this.#l1Max) {
            const oldest = this.#oldestEntry();
            if (oldest === undefined) break;
            const [k, e] = oldest;
            this.#l1.delete(k);
            if (e.hits > 1 && reprieves > 0) {
                reprieves--; e.hits = 1; this.#l1.set(k, e); continue;      // re-queue
            }
            this.#l1Bytes -= e.bytes;
            if (e.hash !== undefined) this.#byHash.delete(e.hash);          // was leaked
        }
    }
    // Oldest live entry, in insertion order.
    //
    // This used to be `this.#l1.entries().next()`. V8's OrderedHashMap does not
    // compact on delete -- it tombstones and only rehashes later -- so a FRESH
    // iterator must skip the entire accumulated run of holes at the front on
    // every single call. Using a Map as a FIFO queue that way is O(n) per
    // eviction. Measured in isolation (no cache involved), popping the oldest
    // key from a steady-size Map: 1671ns at 8k entries, 6173ns at 32k, 20018ns
    // at 128k with a fresh iterator, against 89/94/115ns with a retained one --
    // 174x at 128k. That was the whole reason a cold-read workload got *slower*
    // as L1 grew (2832ns at 2MB, 23664ns at 32MB) and then snapped back to
    // 395ns at 128MB, where the set fits and eviction never runs.
    //
    // A retained iterator is safe here: Map iterators are live, so entries
    // appended at the tail after it was created are still visited, and entries
    // deleted ahead of it are skipped. It only needs recreating once exhausted.
    #oldestEntry() {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (this.#l1Iter === null) this.#l1Iter = this.#l1.entries();
            const r = this.#l1Iter.next();
            if (!r.done) return r.value;
            this.#l1Iter = null;          // ran off the end; restart from the front
        }
        return undefined;                 // genuinely empty
    }

    // Runs right after a GC, so used_heap_size is the LIVE set, not live+garbage.
    // The byte budget is an estimate; this is not.
    #onGc(used, limit) {
        if (used === undefined) {
            const h = v8.getHeapStatistics();
            used = h.used_heap_size; limit = h.heap_size_limit;
        }
        this.liveHeapFraction = used / limit;
        if (this.liveHeapFraction < this.#guardMax) return;
        const target = this.#l1Bytes * (1 - this.#guardShed);
        for (const [k, e] of this.#l1) {
            if (this.#l1Bytes <= target) break;
            this.#l1Bytes -= e.bytes;
            this.#l1.delete(k);
            if (e.hash !== undefined) this.#byHash.delete(e.hash);
        }
        this.stats.heapShed = (this.stats.heapShed || 0) + 1;
    }

    #l1Drop(key) {
        const e = this.#l1.get(key);
        if (!e) return;
        this.#l1Bytes -= e.bytes;
        this.#l1.delete(key);
        if (e.hash !== undefined) this.#byHash.delete(e.hash);   // was leaked
    }

    // --- coherence -------------------------------------------------------
    // The primary is the sole writer, so its own L1 is authoritative and it has
    // nothing to drain. Workers check one hot counter, which is usually
    // unchanged, before paying for a real drain.
    #drain() {
        if (this.#id === 0) return;
        // Degraded means the arena is UNMAPPED (we must let go so a new primary
        // can create one), so every native arena call below would return
        // undefined and the ring read would then dereference it. The recovery
        // timer owns re-attaching; until it succeeds this cache is L1-only.
        if (this.#primaryDead || !storeReady) return;
        // A dead primary cannot invalidate anything, so the arena is frozen and
        // increasingly stale. Degrade to L1-only rather than serve it silently.
        // Staleness is a question about TIME, so check it on a clock rather than
        // every 256 drains. Tied to the operation count, a worker doing three
        // reads a second took 85 seconds to notice a dead primary, and one that
        // went quiet and came back served stale data on its first read. monoMs()
        // is ~21ns against the native ringHead() call this function already
        // makes, so the check is free at any call rate.
        if (!this.#primaryDead) {
            const t = monoMs();
            if (t - this.#lastStaleCheck >= 500) {
                this.#lastStaleCheck = t;
                const age = native.heartbeatAgeMs();
                if (age < 0 || age > this.#staleMs) { TurboCache.#degrade(age); return; }
            }
        }
        if (native.ringHead() === this.#cursor) return;
        const r = native.ringRead(this.#cursor, 512);
        if (!r) return;                            // detached mid-drain
        if (r.wrapped) {                       // fell too far behind: flush wholesale
            this.#l1.clear(); this.#byHash.clear(); this.#l1Bytes = 0; this.#l1Iter = null; this.#pendingDel.clear(); this.#pendingDelHash.clear();
            this.#cursor = r.head;
            return;
        }
        for (let i = 0; i < r.hashes.length; i++) {
            if (r.hashes[i] === 'ffffffffffffffff') {     // clearAll sentinel
                this.clearLocal(); this.#cursor = r.head; return;
            }
            // Own records are NOT skipped. The old "our own write, L1 is already
            // correct" shortcut was false whenever L1 had been refilled from L2
            // between queuing and apply - a worker that deleted a key then read
            // it in the same tick kept serving the deleted value forever. The
            // cost of dropping our own entry is one L2 refetch.
            const pk = this.#pendingDelHash.get(r.hashes[i]);
            if (pk !== undefined) {              // the primary applied our delete; L2 is authoritative
                this.#pendingDel.delete(pk); this.#pendingDelHash.delete(r.hashes[i]);
            }
            const k = this.#byHash.get(r.hashes[i]);
            if (k !== undefined) {
                this.#l1Drop(k); this.#byHash.delete(r.hashes[i]); this.stats.invalidated++;
            }
        }
        this.#cursor = r.head;
    }

    // Opt into the shared-memory write path. Falls back silently to IPC when the
    // segment is absent (a primary from before this existed) or when every ring
    // is already claimed -- the cache still works, just on the slower transport.
    useSubmissionRing(segName) {
        try {
            if (!native.submitOpen(segName)) return false;
            const idx = native.submitClaim();
            if (idx < 0) { this.lastError = 'no free submission ring; falling back to IPC'; return false; }
            this.#ringIdx = idx;
            this.#ringMaxValue = native.submitMaxValue();
            submitReady = segName;
            return true;
        } catch { return false; }
    }

    get transport() { return this.#ringIdx >= 0 ? 'shm' : 'ipc'; }

    // --- public API (synchronous) ---------------------------------------
    get(key) {
        this.#drain();
        key = this.#ns + key;
        // Our own delete has not reached the arena yet; serving L2 here would
        // hand back the value this process just deleted.
        if (hasLoneSurrogate(key)) return undefined;   // cannot have been stored
        if (this.#pendingDel.size && this.#pendingDel.has(key)) return undefined;
        const e = this.#l1.get(key);
        // TTL must be enforced in L1 too. The arena expires lazily on read, but
        // an L1 hit never reaches the arena, so without this an expired value
        // is served indefinitely from L1.
        if (e !== undefined && e.exp && e.exp <= monoMs()) { this.#l1Drop(key); }
        else if (e !== undefined) {
            e.hits++; this.stats.l1Hits++;
            // Binary is copied on every read (decision 7): it is mutable, and
            // L1 hands out the same entry to every caller in this process.
            if (Buffer.isBuffer(e.v)) return Buffer.from(e.v);
            // l1Decoded: hand back the cached object (free, but shared/frozen).
            // Otherwise decode per read, giving each caller a fresh mutable one.
            return this.#l1Decoded ? e.v : this.#codec.decode(e.v);
        }
        if (this.#primaryDead) { this.stats.misses++; return undefined; }
        const raw = native.get(key);
        if (raw === undefined) { this.stats.misses++; return undefined; }
        this.stats.l2Hits++;
        // Carry the arena entry's expiry into L1. Without this the refilled L1
        // entry had no TTL at all, so any expiring value read once through L2
        // became immortal in that worker.
        const rem = native.lastTtlRemainingMs();
        const expMs = rem ? monoMs() + rem : 0;
        if (this.#codec && !this.#l1Decoded) {          // safe mode: cache the encoded form
            this.#l1Put(key, raw, native.hashKey(key), raw.length, expMs);
            return this.#codec.decode(raw);
        }
        let v = raw;
        if (this.#codec) { v = this.#codec.decode(raw); if (this.#freeze) TurboCache.deepFreeze(v); }
        this.#l1Put(key, v, native.hashKey(key), this.#noCodec ? 0 : raw.length, expMs);
        // The L2 path used to return the very object it just placed in L1, so a
        // caller mutating a binary result corrupted the cached copy.
        return Buffer.isBuffer(v) ? Buffer.from(v) : v;
    }

    // Always returns a boolean and never throws, so a caller may ignore the
    // result. Because that makes failure quiet, every rejection also bumps a
    // stats counter and records lastError.
    set(key, value, opts) {
        this.stats.sets++;
        key = this.#ns + key;
        // uint32 milliseconds from the arena epoch is ~49 days of range; clamp
        // rather than overflow (ttlMs near INT32_MAX used to overflow the
        // seconds conversion and expire immediately).
        const ttlMs = Math.max(0, Math.min(opts && opts.ttlMs || 0, 0x7fffffff));
        // Keys used to be silently truncated at 512 bytes, so distinct keys
        // collided and returned each other's values. Reject instead.
        if (Buffer.byteLength(key) > this.#keyMax) {
            this.stats.rejectedKey = (this.stats.rejectedKey || 0) + 1;
            this.lastError = `key of ${Buffer.byteLength(key)} bytes exceeds the ${this.#keyMax}-byte limit`;
            return false;
        }
        // An empty key is rejected by the submission ring's validator, and a
        // rejected record stops that ring permanently -- so a single set('') from
        // a worker silently killed all of its later writes. Reject it up front,
        // in every process, so the two paths agree on what a legal key is.
        if (key.length === 0) {
            this.stats.rejectedKey = (this.stats.rejectedKey || 0) + 1;
            this.lastError = 'key must not be empty';
            return false;
        }
        if (hasLoneSurrogate(key)) {
            this.stats.rejectedKey = (this.stats.rejectedKey || 0) + 1;
            this.lastError = 'key contains an unpaired surrogate';
            return false;
        }
        if (this.#noCodec) {
            const t = typeof value;
            // Binary values are accepted alongside the primitives: decision 4
            // lists Buffer/Uint8Array/ArrayBuffer, and they are byte-shaped
            // rather than object-shaped, so they need no codec.
            const isBinary = ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
            // BigInt is a primitive too, and immutable, so it belongs here.
            if (!isBinary && t !== 'string' && t !== 'number' && t !== 'boolean' && t !== 'bigint' && value !== null) {
                this.stats.rejectedType++;
                this.lastError = `bytes mode accepts string/number/boolean/bigint/null ` +
                    `or binary (Buffer/TypedArray/ArrayBuffer/DataView), got ${t}`;
                return false;
            }
            if (t === 'string') {
                // A V8 SlicedString keeps its parent alive: caching a 1MB
                // substring of an 8MB document retains all 8MB (measured).
                // Flattening costs ~42ns and makes the accounting honest.
                value = native.flatten(value);
            } else if (isBinary) {
                // Decision 7: binary values are mutable, so the cache keeps its
                // own copy rather than sharing the caller's.
                value = Buffer.from(ArrayBuffer.isView(value)
                    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                    : new Uint8Array(value));
            }
        }
        // Encode once: L2 needs bytes regardless, so this is not extra work.
        // A codec can throw on values it cannot represent (JSON on a BigInt or
        // a cycle). set() promises never to throw, so that surfaces as false.
        let enc;
        try { enc = this.#codec ? this.#codec.encode(value) : value; }
        catch (e) {
            this.stats.rejectedType++;
            this.lastError = `codec.encode failed: ${e.message}`;
            return false;
        }
        // JSON.stringify returns undefined (rather than throwing) for a
        // function, a symbol or undefined itself, so a successful encode is not
        // proof of a usable result.
        if (this.#codec && typeof enc !== 'string') {
            this.stats.rejectedType++;
            this.lastError = `codec.encode produced ${typeof enc}, not a string (value type ${typeof value})`;
            return false;
        }
        let l1Value = value;
        if (this.#codec && !this.#l1Decoded) l1Value = enc;             // safe: keep the encoded form
        else if (this.#codec && this.#isolate) l1Value = this.#codec.decode(enc);
        // Freeze only ever applies to an object the cache owns. Freezing the
        // caller's object would be a side effect on something they still hold.
        if (this.#codec && this.#freeze) TurboCache.deepFreeze(l1Value);
        const keyHash = native.hashKey(key);
        this.#pendingDel.delete(key); this.#pendingDelHash.delete(keyHash);   // a write supersedes our pending delete
        // set() reports whether the pipeline ACCEPTED, serialised and queued the
        // value - not that it is durably in L2. A worker's write is applied by
        // the primary a tick later, so the size must be checked here; otherwise
        // an oversized value would be queued, silently dropped by the primary,
        // and reported as success.
        // UTF-8 BYTES, not UTF-16 units: the old check accepted values the
        // primary then rejected, destroying the previous value silently.
        const encLen = typeof enc === 'string' ? Buffer.byteLength(enc)
            : (Buffer.isBuffer(enc) ? enc.length : 8);
        if (encLen + key.length + 48 > this.#maxValue) {
            this.stats.rejectedSize++;
            this.lastError = `value ${encLen}B exceeds the ${this.#maxValue}B arena limit`;
            return false;
        }
        // A value can fit the arena and still be too large for a submission ring
        // record. That is a PERMANENT condition, not the transient "ring full"
        // backpressure, so it must be reported as a rejection here rather than as
        // an endless stream of successful-looking writes that never reach L2.
        if (this.#ringIdx >= 0 && this.#ringMaxValue > 0 && encLen > this.#ringMaxValue) {
            this.stats.rejectedSize++;
            this.lastError = `value ${encLen}B exceeds the ${this.#ringMaxValue}B submission-ring limit ` +
                             `(raise submitRingBytes on the primary)`;
            return false;
        }
        this.#l1Put(key, l1Value, keyHash, this.#noCodec ? 0 : enc.length,
                    ttlMs > 0 ? monoMs() + ttlMs : 0);
        if (this.#id === 0) {
            const ok = native.set(key, enc, 0, ttlMs, this.#nsId) === true;
            if (!ok) { this.stats.rejectedSize++; this.lastError = 'value does not fit the arena'; this.#l1Drop(key); }
            return ok;
        }
        // Shared-memory submission: a memcpy into this worker's own ring, which
        // the primary already has mapped. The IPC path is kept as a fallback for
        // when the ring segment is unavailable (older primary, claim failed).
        if (this.#ringIdx >= 0) {
            if (native.submitSet(key, enc, ttlMs, this.#nsId)) { this.stats.sent++; this.#ringDoorbell(); return true; }
            // Ring full. Same contract as a shed IPC write: the value is in this
            // worker's L1, it just has not reached L2, so other workers see a
            // miss rather than a wrong value. Counted, never silent.
            this.stats.writesShed = (this.stats.writesShed || 0) + 1;
            this.lastError = 'submission ring full; L2 write shed';
            return true;
        }
        this.#outbox.push('s', key, enc, ttlMs, this.#nsId);
        this.#schedule(encLen + key.length + 48);
        return true;                      // queued; capacity is decided by the primary
    }

    // Edge-triggered doorbell. The primary only needs waking when its rings go
    // from empty to non-empty: while it is already draining, every extra
    // notification is pure waste, and under load the ring is almost never empty
    // so this fires rarely. A timer instead would either burn wakeups finding
    // nothing or add latency waiting for the next tick.
    #ringDoorbell() {
        if (this.#doorbellPending) return;
        this.#doorbellPending = true;
        // A one-field message, not a batch: this is a notification, not a
        // transport. The payload that used to freeze the event loop for
        // 0.49-1.15ms per send now travels through shared memory instead.
        setImmediate(() => {
            this.#doorbellPending = false;
            if (process.connected) { try { process.send({ t: RING_MSG, id: this.#id }); } catch { /* shutting down */ } }
        });
    }

    // Batching normally waits for the next tick, but a worker doing a long
    // SYNCHRONOUS burst never turns the event loop, so setImmediate never fires
    // and the outbox grows without bound - measured at 50MB of worker heap for
    // 60k sets. Flush eagerly once it exceeds a byte cap: process.send can be
    // called at any time, the tick is only there to batch.
    #schedule(addedBytes) {
        this.#outboxBytes += addedBytes;
        if (this.#outboxBytes >= this.#outboxMaxBytes) { this.flush(); return; }
        if (this.#flushScheduled) return;
        this.#flushScheduled = true;
        setImmediate(() => this.flush());
    }

    // Existence check only: no decode, no promotion into L1, not counted as a
    // hit, and it deliberately leaves the CLOCK reference bit alone.
    has(key) {
        this.#drain();
        key = this.#ns + key;
        if (hasLoneSurrogate(key)) return false;
        if (this.#pendingDel.size && this.#pendingDel.has(key)) return false;
        const e = this.#l1.get(key);
        if (e !== undefined) {
            if (!e.exp || e.exp > monoMs()) return true;
            this.#l1Drop(key);
        }
        return native.has(key);
    }

    delete(key) {
        key = this.#ns + key;
        this.stats.deletes++;
        if (this.#id === 0) { const had = native.del(key, 0); this.#l1Drop(key); return had; }
        // A worker's delete is applied a tick later, so report whether the key
        // was present at call time. Returning an unconditional true meant a
        // worker and the primary disagreed about the same absent key.
        const had = this.#l1.has(key) || native.has(key);
        this.#l1Drop(key);
        // A worker's delete is applied by the primary a tick later, so a get()
        // in between refilled L1 straight from L2 and served the value this
        // worker just deleted. Remember the key until the invalidation for it
        // comes back around. Bounded: if the primary is not applying our
        // deletes, dropping the record only costs us a stale read, whereas
        // growing without bound costs the process.
        if (this.#pendingDel.size >= 4096) { this.#pendingDel.clear(); this.#pendingDelHash.clear(); }
        this.#pendingDel.add(key);
        this.#pendingDelHash.set(native.hashKey(key), key);
        if (this.#ringIdx >= 0) {
            if (native.submitDel(key, this.#nsId)) this.#ringDoorbell();
            else this.stats.writesShed = (this.stats.writesShed || 0) + 1;
            return had;
        }
        this.#outbox.push('d', key, null, 0, this.#nsId);
        this.#schedule(key.length + 48);
        return had;
    }

    // Drops only this process's L1. The shared arena is untouched, so the next
    // read simply repopulates it.
    clearLocal() {
        this.#l1.clear(); this.#byHash.clear(); this.#l1Bytes = 0; this.#l1Iter = null; this.#pendingDel.clear(); this.#pendingDelHash.clear();
    }

    // Wipes the shared arena AND every worker's L1, via a flush record on the
    // invalidation ring. Deliberately not called clear(): this is a
    // cluster-wide side effect and the name should say so.
    clearAll() {
        this.clearLocal();
        if (this.#id === 0) { native.clearAll(0); return; }
        this.#outbox.push('c', '', null, 0, this.#nsId);
        this.#schedule(48);
    }

    // Atomic increment. The primary is the sole writer, so on the primary this
    // is genuinely atomic and returns the NEW value. In a worker the write is
    // applied a tick later, so the result cannot be known synchronously without
    // a round trip that does not exist yet: the delta is queued and undefined
    // is returned. Read it back with get() once applied.
    //
    // A missing key counts as zero. Returns false if the key holds a non-numeric
    // value, matching set()'s "accepted" contract.
    incr(key, by = 1, opts) {
        const full = this.#ns + key;
        const ttlMs = Math.max(0, Math.min(opts && opts.ttlMs || 0, 0x7fffffff));
        if (Buffer.byteLength(full) > this.#keyMax) {
            this.stats.rejectedKey = (this.stats.rejectedKey || 0) + 1;
            this.lastError = 'key too long';
            return false;
        }
        this.#l1Drop(full);                     // the arena becomes authoritative
        if (this.#id === 0) {
            const v = native.incr(full, by, 0, ttlMs, this.#nsId);
            if (v === undefined) { this.lastError = 'incr on a non-numeric value'; return false; }
            return v;
        }
        this.#outbox.push('i', full, by, ttlMs, this.#nsId);
        this.#schedule(full.length + 48);
        this.stats.incrQueued = (this.stats.incrQueued || 0) + 1;
        return undefined;                       // queued; read it back with get()
    }

    // Compare-and-set on a numeric value. Primary-only: a queued CAS whose
    // outcome the caller never learns is not a CAS, so a worker gets an error
    // rather than a misleading `true`.
    cas(key, expected, next) {
        if (this.#id !== 0)
            throw new Error('cas() is primary-only: a worker cannot learn the outcome ' +
                            'of a write applied a tick later');
        const full = this.#ns + key;
        this.#l1Drop(full);
        return native.cas(full, expected, next, 0) === true;
    }

    // Drops every entry of THIS cache's namespace, leaving other namespaces
    // untouched. The blunt clearAll() wipes the whole arena.
    clearNamespace() {
        this.clearLocal();
        if (this.#id === 0) return native.clearNamespace(this.#nsId, 0);
        this.#outbox.push('n', '', null, 0, this.#nsId);
        this.#schedule(48);
        return true;
    }

    static namespaceStats() { return native.nsStats(); }

    // Whether this addon build can compress. Compression is optional at build
    // time so the default build has no external dependencies.
    static hasCompression() { return native.hasLz4(); }

    // Live entries in this cache's namespace. Arena-wide counters are in
    // TurboCache.arenaStats().
    get size() {
        const st = native.nsStats();
        if (!st) return 0;
        if (this.#nsId === 0 && st.length <= 1) return (native.stats() || {}).live || 0;
        let n = 0;
        for (const k of this.keys({ limit: Infinity })) n++;
        return n;
    }

    static arenaStats() { return native.stats(); }

    // Enumerate the keys this cache's namespace holds, newest-slot order.
    // O(index slots); intended for operations and debugging, not the hot path.
    *keys({ limit = 1000, batch = 512 } = {}) {
        let cursor = 0, yielded = 0;
        for (;;) {
            const r = native.scanKeys(this.#nsId, cursor, batch);
            if (!r) return;
            for (const k of r.keys) {
                if (yielded++ >= limit) return;
                yield this.#ns ? k.slice(this.#ns.length) : k;
            }
            if (r.done) return;
            cursor = r.cursor;
        }
    }

    // The primary stamps a heartbeat and reclaims expired entries on a timer.
    // Expiry was lazy only, so an expired entry held its index slot and arena
    // bytes until the tail reached it; and heartbeatNs was never written, so a
    // worker could not tell a live arena from one whose primary had died.
    _startMaintenance(opts = {}) {
        if (this.#id !== 0 || opts.maintenance === false) return;
        const everyMs = opts.maintenanceMs || 500;
        // Size the slice so a full pass over the index completes in a bounded
        // time regardless of index size. A fixed slice covered only ~3% of a
        // 1M-slot index per second, so expired entries lingered for minutes.
        const fullPassMs = opts.sweepFullPassMs || 30000;
        const slots = (native.stats() || {}).indexSlots || 65536;
        const slice = opts.sweepSlots ||
            Math.max(1024, Math.ceil(slots / Math.max(1, fullPassMs / everyMs)));
        native.heartbeat();
        this.#timer = setInterval(() => {
            native.heartbeat();
            const r = native.sweepExpired(this.#sweepCursor, slice);
            if (!r) return;
            this.#sweepCursor = r.cursor;
            this.stats.expired = (this.stats.expired || 0) + r.removed;
        }, everyMs);
        if (this.#timer.unref) this.#timer.unref();   // never holds the process open
    }

    // Milliseconds since the primary last stamped the arena, or -1 if it never
    // has. A worker seeing a large value stops trusting L2.
    static primaryAgeMs() { return native.heartbeatAgeMs(); }

    close() {
        this.stopGuard();
        if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
        instances.delete(this);
        // Release this process's ring slot, or it stays owned by a dead pid
        // forever: after enough worker churn every slot is taken, submitClaim
        // returns -1, and every new worker silently falls back to IPC.
        try { native.submitRelease(); } catch { /* transport not in use */ }
        if (this.#id === 0 && storeReady) {
            try { native.submitDestroy(); } catch { /* not created */ }
            submitName = null; isPrimaryProcess = false;
            native.destroy(); storeReady = false;
        }
    }

    get l1Size() { return this.#l1.size; }

    stopGuard() { if (this.#gcObserver) { this.#gcObserver = null; gcUnsubscribe(this); } }

    flush() {
        this.#flushScheduled = false;
        if (!this.#outbox.length) return;
        // Do not push into a congested channel. process.send() queues into
        // libuv, which is UNBOUNDED: under sustained write load the worker's
        // RSS grew past 485MB while its JS heap stayed flat, because the
        // backlog lives outside the heap. Wait for the drain callback instead.
        // The bound must be on BYTES IN FLIGHT, not on "is one message
        // outstanding". `false` from process.send only means libuv's buffer is
        // above its high-water mark right now -- it does not mean the channel is
        // saturated. Treating it as a stop-everything flag allowed exactly one
        // message in flight and discarded everything produced while it was
        // pending, which capped delivery at ~60k writes/s. Measured with no cache
        // in the way, the same channel carries 439 MB/s under JSON and 1738 MB/s
        // under 'advanced' -- equivalent to 1.8M and 7.3M writes/s. The ceiling
        // was this policy, not the transport.
        if (this.#inFlightBytes >= this.#maxInFlightBytes) {
            if (this.#outboxBytes < this.#outboxMaxBytes) return;   // keep batching
            // Window full AND our own buffer is full: shed rather than grow
            // without bound. The value stays in this worker's L1, it just does
            // not reach L2, so other workers see a miss, never a wrong value.
            this.stats.writesShed = (this.stats.writesShed || 0) + this.#outbox.length / 5;
            this.#outbox = [];
            this.#outboxBytes = 0;
            this.lastError = 'IPC send window full; L2 writes shed';
            return;
        }
        const batch = this.#outbox;
        const batchBytes = this.#outboxBytes;
        this.#outbox = [];
        this.#outboxBytes = 0;
        this.stats.flushes++;
        this.stats.sent += batch.length / 5;
        // The channel can already be gone: a scheduled flush firing after the
        // primary exited threw EPIPE and killed the worker with an unhandled
        // 'error' event. Losing a batch during shutdown is acceptable; crashing
        // the worker over it is not.
        if (!process.connected) { this.stats.flushDropped = (this.stats.flushDropped || 0) + 1; return; }
        // The write fails ASYNCHRONOUSLY, so try/catch cannot see it; without a
        // callback Node emits an unhandled 'error' event that kills the process.
        // Passing a callback routes the failure here instead - and tells us when
        // the message actually reached the channel, which is our drain signal.
        const self = this;
        try {
            // Reserve AFTER the call cannot throw synchronously. process.send
            // throws for a value the serializer cannot represent (a BigInt under
            // JSON serialization), and reserving first meant the catch below
            // never returned those bytes -- eight such batches wedged the worker
            // for its lifetime while every set() still reported success.
            this.#inFlightBytes += batchBytes;
            let sendThrew = true;
            const accepted = process.send({ t: MSG, id: this.#id, b: batch }, err => {
                self.#inFlightBytes -= batchBytes;
                if (self.#inFlightBytes < 0) self.#inFlightBytes = 0;
                if (!err) return;
                self.stats.flushDropped = (self.stats.flushDropped || 0) + 1;
                self.lastError = `flush failed: ${err.code || err.message}`;
            });
            // false means the backlog is above libuv's high-water mark.
            // Informational only now: a `false` return is normal backpressure and
            // the window, not this flag, decides whether we keep sending.
            sendThrew = false;
            if (accepted === false) this.stats.congested = (this.stats.congested || 0) + 1;
        } catch (e) {
            // Synchronous throw: the callback will never run, so return the bytes
            // here or the window shrinks permanently and the worker stops writing.
            if (sendThrew) {
                this.#inFlightBytes -= batchBytes;
                if (this.#inFlightBytes < 0) this.#inFlightBytes = 0;
            }
            this.stats.flushDropped = (this.stats.flushDropped || 0) + 1;
            this.lastError = `flush failed: ${e.code || e.message}`;
        }
    }

    // Primary side: apply a worker's batch to L2.
    // Applied on the PRIMARY. The primary's #drain is a no-op (it is the sole
    // writer of its own records), so a worker's write would otherwise never
    // invalidate the primary's L1 - it kept serving its own stale value even
    // after a worker overwrote or deleted the key.
    static applyBatch(msg) {
        // set/delete travel through the shared-memory ring while incr/clearAll/
        // clearNamespace still travel over IPC. A worker pushes to its ring
        // synchronously and sends the IPC message afterwards, so draining the
        // rings to empty here is what keeps one worker's operations in order --
        // without it a clearAll() was observed leaving 3808 keys that had been
        // written before it.
        if (submitName) { let guard = 0; while (TurboCache.drainSubmissions(8192) > 0 && ++guard < 512); }
        const b = msg.b;
        for (let i = 0; i < b.length; i += 5) {
            const op = b[i], key = b[i + 1];
            if (op === 's') { native.set(key, b[i + 2], msg.id, b[i + 3], b[i + 4]); TurboCache.#localDrop(key); }
            else if (op === 'd') { native.del(key, msg.id); TurboCache.#localDrop(key); }
            else if (op === 'c') { native.clearAll(msg.id); for (const c of instances) c.clearLocal(); }
            else if (op === 'n') { native.clearNamespace(b[i + 4], msg.id); for (const c of instances) c.clearLocal(); }
            else if (op === 'i') { native.incr(key, b[i + 2], msg.id, b[i + 3], b[i + 4]); TurboCache.#localDrop(key); }
        }
    }

    static #localDrop(fullKey) { for (const c of instances) c._dropExact(fullKey); }
    _dropExact(fullKey) { this.#l1Drop(fullKey); }
    static isCacheMessage(m) { return m && m.t === MSG; }
    static native() { return native; }
}

module.exports = { TurboCache, Cache: TurboCache, MSG };
