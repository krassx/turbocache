'use strict';
// Thin JS layer over the L2 prototype, implementing the architecture in DESIGN.md:
//   L1  - per-worker JS Map with a byte budget (values are decoded strings)
//   L2  - shared arena; primary is the sole writer, workers map it read-only
//   writes - worker buffers, then batches to the primary over cluster IPC
//   coherence - workers drain the shared invalidation ring and drop stale L1 entries
const cluster = require('cluster');
const native = require('./build/Release/l2.node');
const v8 = require('v8');
const v8ser = require('v8');
const { PerformanceObserver } = require('perf_hooks');

const MSG = 'tc';

class TurboCache {
    #l1 = new Map();          // key -> { v, bytes, hits }
    #byHash = new Map();      // hash hex -> key   (ring records carry hashes)
    #l1Bytes = 0;
    #l1Max;
    #outbox = [];
    #flushScheduled = false;
    #cursor = 0;
    #ns = '';
    #maxValue = 0;
    #id;
    #codec;
    #l1Decoded = true;
    #isolate = true;
    #primitives = false;
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
        this.#ns = opts.namespace ? opts.namespace + ':' : '';
        this.#maxValue = native.maxValueBytes();
        this.#l1Max = opts.l1MaxBytes || 2 * 1024 * 1024;
        this.#id = opts.workerId || 0;
        this.#attached = opts.attached !== false;
        // 'primitives' mode: accept only string/number/boolean/null. Buys three
        // things the codec mode cannot: byte accounting that is exact rather
        // than a heapFactor estimate, no aliasing hazard (primitives are
        // immutable), and no codec to configure. Costs the caller a decode on
        // every L1 hit if its values are really objects.
        // Storage modes. Each names the tradeoff it accepts:
        //
        //   primitives - scalars only, rejects anything else LOUDLY.
        //                Exact byte accounting, no aliasing, no codec.
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
        } else if (preset === 'primitives') {
            opts = { ...opts, values: 'primitives' };
        }
        this.storage = preset || (opts.codec ? 'codec' : 'primitives');
        // safe mode keeps the ENCODED form in L1 and decodes on every read, so
        // each caller gets its own object. direct keeps the decoded object.
        this.#l1Decoded = opts.l1Decoded !== false;
        this.#primitives = opts.values === 'primitives';
        this.#codec = this.#primitives ? null : (opts.codec || null);
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
        this.#heapFactor = (this.#primitives || !this.#l1Decoded) ? 1
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
            const self = this;
            this.#gcObserver = new PerformanceObserver(list => {
                for (const e of list.getEntries()) {
                    if (e.detail && e.detail.kind === undefined) continue;
                    self.#onGc();
                }
            });
            this.#gcObserver.observe({ entryTypes: ['gc'] });
            if (this.#gcObserver.disconnect) { /* caller may stop() */ }
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
    static open(opts = {}) {
        const cluster = require('cluster');
        const auto = TurboCache.autoSize();
        const arenaBytes = opts.arenaBytes || auto.arenaBytes;
        const indexSlots = opts.indexSlots || auto.indexSlots;
        const o = { l1MaxBytes: auto.l1MaxBytes, ...opts };
        if (cluster.isWorker && process.env.TURBOCACHE_ARENA) {
            return TurboCache.attachWorker(process.env.TURBOCACHE_ARENA, cluster.worker.id, o);
        }
        const name = opts.name || ('/turbocache-' + process.pid);
        process.env.TURBOCACHE_ARENA = name;      // inherited by workers forked later
        return TurboCache.createPrimary(name, arenaBytes, indexSlots, o);
    }

    // Wire the primary's side of the worker write path. Without this, worker
    // writes never reach L2.
    static install(cluster) {
        cluster.on('online', w => w.on('message', m => {
            if (TurboCache.isCacheMessage(m)) TurboCache.applyBatch(m);
        }));
        for (const id in cluster.workers) {
            const w = cluster.workers[id];
            w.on('message', m => { if (TurboCache.isCacheMessage(m)) TurboCache.applyBatch(m); });
        }
    }

    static createPrimary(name, arenaBytes, indexSlots, opts = {}) {
        if (!native.create(name, arenaBytes, indexSlots, 2)) throw new Error('arena create failed');
        native.setCompressMin(1 << 30);                 // compression off, per DESIGN.md
        return new TurboCache({ ...opts, workerId: 0 });
    }
    static attachWorker(name, workerId, opts = {}) {
        if (!native.attach(name)) throw new Error('arena attach failed');
        return new TurboCache({ ...opts, workerId });
    }

    // --- L1 --------------------------------------------------------------
    #l1Put(key, v, hash, encodedLen, expiresAt = 0) {
        // In primitives mode the cost is known exactly; otherwise it is the
        // encoded length scaled by heapFactor, which is only an estimate.
        const bytes = this.#primitives
            ? native.primBytes(v) + native.primBytes(key) + 64
            : (key.length + encodedLen + 64) * this.#heapFactor;
        const prev = this.#l1.get(key);
        if (prev) this.#l1Bytes -= prev.bytes;
        this.#l1.set(key, { v, bytes, hits: 1, exp: expiresAt });
        this.#byHash.set(hash, key);
        this.#l1Bytes += bytes;

        // FIFO with second chance: Map preserves insertion order, so the oldest
        // entry is first. A entry that has been read again gets one reprieve.
        while (this.#l1Bytes > this.#l1Max) {
            const it = this.#l1.entries().next();
            if (it.done) break;
            const [k, e] = it.value;
            this.#l1.delete(k);
            if (e.hits > 1) { e.hits = 1; this.#l1.set(k, e); continue; }   // re-queue
            this.#l1Bytes -= e.bytes;
        }
    }
    // Runs right after a GC, so used_heap_size is the LIVE set, not live+garbage.
    // The byte budget is an estimate; this is not.
    #onGc() {
        const h = v8.getHeapStatistics();
        this.liveHeapFraction = h.used_heap_size / h.heap_size_limit;
        if (this.liveHeapFraction < this.#guardMax) return;
        const target = this.#l1Bytes * (1 - this.#guardShed);
        for (const [k, e] of this.#l1) {
            if (this.#l1Bytes <= target) break;
            this.#l1Bytes -= e.bytes;
            this.#l1.delete(k);
        }
        this.stats.heapShed = (this.stats.heapShed || 0) + 1;
    }

    #l1Drop(key) {
        const e = this.#l1.get(key);
        if (!e) return;
        this.#l1Bytes -= e.bytes;
        this.#l1.delete(key);
    }

    // --- coherence -------------------------------------------------------
    // The primary is the sole writer, so its own L1 is authoritative and it has
    // nothing to drain. Workers check one hot counter, which is usually
    // unchanged, before paying for a real drain.
    #drain() {
        if (this.#id === 0) return;
        if (native.ringHead() === this.#cursor) return;
        const r = native.ringRead(this.#cursor, 512);
        if (r.wrapped) {                       // fell too far behind: flush wholesale
            this.#l1.clear(); this.#byHash.clear(); this.#l1Bytes = 0;
            this.#cursor = r.head;
            return;
        }
        for (let i = 0; i < r.hashes.length; i++) {
            if (r.hashes[i] === 'ffffffffffffffff') {     // clearAll sentinel
                this.clearLocal(); this.#cursor = r.head; return;
            }
            if (r.writers[i] === this.#id) continue;      // our own write; L1 already correct
            const k = this.#byHash.get(r.hashes[i]);
            if (k !== undefined) { this.#l1Drop(k); this.#byHash.delete(r.hashes[i]); this.stats.invalidated++; }
        }
        this.#cursor = r.head;
    }

    // --- public API (synchronous) ---------------------------------------
    get(key) {
        this.#drain();
        key = this.#ns + key;
        const e = this.#l1.get(key);
        // TTL must be enforced in L1 too. The arena expires lazily on read, but
        // an L1 hit never reaches the arena, so without this an expired value
        // is served indefinitely from L1.
        if (e !== undefined && e.exp && e.exp <= Date.now()) { this.#l1Drop(key); }
        else if (e !== undefined) {
            e.hits++; this.stats.l1Hits++;
            // l1Decoded: hand back the cached object (free, but shared/frozen).
            // Otherwise decode per read, giving each caller a fresh mutable one.
            return this.#l1Decoded ? e.v : this.#codec.decode(e.v);
        }
        const raw = native.get(key);
        if (raw === undefined) { this.stats.misses++; return undefined; }
        this.stats.l2Hits++;
        if (this.#codec && !this.#l1Decoded) {          // safe mode: cache the encoded form
            this.#l1Put(key, raw, native.hashKey(key), raw.length);
            return this.#codec.decode(raw);
        }
        let v = raw;
        if (this.#codec) { v = this.#codec.decode(raw); if (this.#freeze) TurboCache.deepFreeze(v); }
        this.#l1Put(key, v, native.hashKey(key), this.#primitives ? 0 : raw.length);
        return v;
    }

    // Always returns a boolean and never throws, so a caller may ignore the
    // result. Because that makes failure quiet, every rejection also bumps a
    // stats counter and records lastError.
    set(key, value, opts) {
        this.stats.sets++;
        key = this.#ns + key;
        const ttlMs = (opts && opts.ttlMs) | 0;
        if (this.#primitives) {
            const t = typeof value;
            // BigInt is a primitive too, and immutable, so it belongs here.
            if (t !== 'string' && t !== 'number' && t !== 'boolean' && t !== 'bigint' && value !== null) {
                this.stats.rejectedType++;
                this.lastError = `primitives mode accepts string/number/boolean/bigint/null, got ${t}`;
                return false;
            }
            if (t === 'string') {
                // A V8 SlicedString keeps its parent alive: caching a 1MB
                // substring of an 8MB document retains all 8MB (measured).
                // Flattening costs ~42ns and makes the accounting honest.
                value = native.flatten(value);
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
        // set() reports whether the pipeline ACCEPTED, serialised and queued the
        // value - not that it is durably in L2. A worker's write is applied by
        // the primary a tick later, so the size must be checked here; otherwise
        // an oversized value would be queued, silently dropped by the primary,
        // and reported as success.
        const encLen = typeof enc === 'string' ? enc.length : 8;
        if (encLen + key.length + 48 > this.#maxValue) {
            this.stats.rejectedSize++;
            this.lastError = `value ${encLen}B exceeds the ${this.#maxValue}B arena limit`;
            return false;
        }
        this.#l1Put(key, l1Value, native.hashKey(key), this.#primitives ? 0 : enc.length,
                    ttlMs > 0 ? Date.now() + ttlMs : 0);
        if (this.#id === 0) {
            const ok = native.set(key, enc, 0, ttlMs);
            if (!ok) { this.stats.rejectedSize++; this.lastError = 'value does not fit the arena'; this.#l1Drop(key); }
            return ok;
        }
        this.#outbox.push('s', key, enc, ttlMs);
        this.#schedule();
        return true;                      // queued; capacity is decided by the primary
    }

    #schedule() {
        if (this.#flushScheduled) return;
        this.#flushScheduled = true;
        setImmediate(() => this.flush());
    }

    // Existence check only: no decode, no promotion into L1, not counted as a
    // hit, and it deliberately leaves the CLOCK reference bit alone.
    has(key) {
        this.#drain();
        key = this.#ns + key;
        const e = this.#l1.get(key);
        if (e !== undefined) {
            if (!e.exp || e.exp > Date.now()) return true;
            this.#l1Drop(key);
        }
        return native.has(key);
    }

    delete(key) {
        key = this.#ns + key;
        this.stats.deletes++;
        this.#l1Drop(key);
        if (this.#id === 0) return native.del(key, 0);
        this.#outbox.push('d', key, null, 0);
        this.#schedule();
        return true;
    }

    // Drops only this process's L1. The shared arena is untouched, so the next
    // read simply repopulates it.
    clearLocal() {
        this.#l1.clear(); this.#byHash.clear(); this.#l1Bytes = 0;
    }

    // Wipes the shared arena AND every worker's L1, via a flush record on the
    // invalidation ring. Deliberately not called clear(): this is a
    // cluster-wide side effect and the name should say so.
    clearAll() {
        this.clearLocal();
        if (this.#id === 0) { native.clearAll(0); return; }
        this.#outbox.push('c', '', null, 0);
        this.#schedule();
    }

    close() {
        this.stopGuard();
        if (this.#id === 0) native.destroy();
    }

    get l1Size() { return this.#l1.size; }

    stopGuard() { if (this.#gcObserver) { this.#gcObserver.disconnect(); this.#gcObserver = null; } }

    flush() {
        this.#flushScheduled = false;
        if (!this.#outbox.length) return;
        const batch = this.#outbox;
        this.#outbox = [];
        this.stats.flushes++;
        this.stats.sent += batch.length / 4;
        process.send({ t: MSG, id: this.#id, b: batch });
    }

    // Primary side: apply a worker's batch to L2.
    static applyBatch(msg) {
        const b = msg.b;
        for (let i = 0; i < b.length; i += 4) {
            const op = b[i];
            if (op === 's') native.set(b[i + 1], b[i + 2], msg.id, b[i + 3]);
            else if (op === 'd') native.del(b[i + 1], msg.id);
            else if (op === 'c') native.clearAll(msg.id);
        }
    }
    static isCacheMessage(m) { return m && m.t === MSG; }
    static native() { return native; }
}

module.exports = { TurboCache, MSG };
