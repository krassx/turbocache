'use strict';
// Thin JS layer over the L2 prototype, implementing the architecture in DESIGN.md:
//   L1  - per-worker JS Map with a byte budget (values are decoded strings)
//   L2  - shared arena; primary is the sole writer, workers map it read-only
//   writes - worker buffers, then batches to the primary over cluster IPC
//   coherence - workers drain the shared invalidation ring and drop stale L1 entries
const cluster = require('cluster');
const native = require('./build/Release/l2.node');
const v8 = require('v8');
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
    #id;
    #codec;
    #isolate = true;
    #primitives = false;
    #freeze;
    #heapFactor;
    #guardMax = 0; #guardShed = 0.25; #gcObserver = null; liveHeapFraction = 0;
    #attached = false;
    stats = { l1Hits: 0, l2Hits: 0, misses: 0, sets: 0, invalidated: 0, flushes: 0, sent: 0 };

    // Resolves the decision 4 / decision 5 tension. L2 still stores bytes only
    // (decision 4 holds at the wire and arena boundary). But when a codec is
    // supplied, L1 holds the DECODED value, so an L1 hit skips decoding
    // entirely - which is what decision 5 was actually for. Without a codec the
    // value is already opaque bytes and L1 is optimal as-is.
    constructor(opts = {}) {
        this.#l1Max = opts.l1MaxBytes || 2 * 1024 * 1024;
        this.#id = opts.workerId || 0;
        this.#attached = opts.attached !== false;
        // 'primitives' mode: accept only string/number/boolean/null. Buys three
        // things the codec mode cannot: byte accounting that is exact rather
        // than a heapFactor estimate, no aliasing hazard (primitives are
        // immutable), and no codec to configure. Costs the caller a decode on
        // every L1 hit if its values are really objects.
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
        this.#heapFactor = this.#primitives ? 1 : (opts.heapFactor || (this.#codec ? 3 : 1));
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

    static deepFreeze(o) {
        if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
        Object.freeze(o);
        for (const k in o) TurboCache.deepFreeze(o[k]);
        return o;
    }

    // --- lifecycle -------------------------------------------------------
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
    #l1Put(key, v, hash, encodedLen) {
        // In primitives mode the cost is known exactly; otherwise it is the
        // encoded length scaled by heapFactor, which is only an estimate.
        const bytes = this.#primitives
            ? native.primBytes(v) + native.primBytes(key) + 64
            : (key.length + encodedLen + 64) * this.#heapFactor;
        const prev = this.#l1.get(key);
        if (prev) this.#l1Bytes -= prev.bytes;
        this.#l1.set(key, { v, bytes, hits: 1 });
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
            if (r.writers[i] === this.#id) continue;      // our own write; L1 already correct
            const k = this.#byHash.get(r.hashes[i]);
            if (k !== undefined) { this.#l1Drop(k); this.#byHash.delete(r.hashes[i]); this.stats.invalidated++; }
        }
        this.#cursor = r.head;
    }

    // --- public API (synchronous) ---------------------------------------
    get(key) {
        this.#drain();
        const e = this.#l1.get(key);
        if (e !== undefined) { e.hits++; this.stats.l1Hits++; return e.v; }   // no decode
        const raw = native.get(key);
        if (raw === undefined) { this.stats.misses++; return undefined; }
        this.stats.l2Hits++;
        let v = raw;
        if (this.#codec) { v = this.#codec.decode(raw); if (this.#freeze) TurboCache.deepFreeze(v); }
        this.#l1Put(key, v, native.hashKey(key), this.#primitives ? 0 : raw.length);
        return v;
    }

    set(key, value) {
        this.stats.sets++;
        if (this.#primitives) {
            const t = typeof value;
            if (t !== 'string' && t !== 'number' && t !== 'boolean' && value !== null)
                throw new TypeError(`primitives mode accepts string/number/boolean/null, got ${t}`);
            if (t === 'string') {
                // A V8 SlicedString keeps its parent alive: caching a 1MB
                // substring of an 8MB document retains all 8MB (measured).
                // Flattening costs ~42ns and makes the accounting honest.
                value = native.flatten(value);
            }
        }
        // Encode once: L2 needs bytes regardless, so this is not extra work.
        const enc = this.#codec ? this.#codec.encode(value) : value;
        let l1Value = value;
        if (this.#codec && this.#isolate) l1Value = this.#codec.decode(enc);
        // Freeze only ever applies to an object the cache owns. Freezing the
        // caller's object would be a side effect on something they still hold.
        if (this.#codec && this.#freeze) TurboCache.deepFreeze(l1Value);
        this.#l1Put(key, l1Value, native.hashKey(key), this.#primitives ? 0 : enc.length);
        if (this.#id === 0) { native.set(key, enc, 0); return; }   // primary writes directly
        this.#outbox.push(key, enc);
        if (!this.#flushScheduled) {
            this.#flushScheduled = true;
            setImmediate(() => this.flush());
        }
    }

    get l1Size() { return this.#l1.size; }

    stopGuard() { if (this.#gcObserver) { this.#gcObserver.disconnect(); this.#gcObserver = null; } }

    flush() {
        this.#flushScheduled = false;
        if (!this.#outbox.length) return;
        const batch = this.#outbox;
        this.#outbox = [];
        this.stats.flushes++;
        this.stats.sent += batch.length / 2;
        process.send({ t: MSG, id: this.#id, b: batch });
    }

    // Primary side: apply a worker's batch to L2.
    static applyBatch(msg) {
        const b = msg.b;
        for (let i = 0; i < b.length; i += 2) native.set(b[i], b[i + 1], msg.id);
    }
    static isCacheMessage(m) { return m && m.t === MSG; }
    static native() { return native; }
}

module.exports = { TurboCache, MSG };
