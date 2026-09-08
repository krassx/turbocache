'use strict';
// Shared workload driver so both caches see an identical request stream.
const BUGSEE = '/Users/alexeykarimov/Projects/Bugsee/appserver/code/components/shared/cache';

function mkRng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

// Zipf s=1.0 over N keys: a few very hot keys, a long cold tail. Produces both
// L1 hits (hot) and misses that must reach L2 (tail) - the point of the test.
function mkZipf(N, rnd) {
    const cdf = new Float64Array(N);
    let sum = 0;
    for (let i = 0; i < N; i++) { sum += 1 / (i + 1); cdf[i] = sum; }
    for (let i = 0; i < N; i++) cdf[i] /= sum;
    return () => {
        const r = rnd(); let lo = 0, hi = N - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
        return lo;
    };
}

const WORDS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet'];

// Values are OBJECTS, because that is what the bugsee cache API takes. Handing
// it a JSON-shaped string would make it escape every quote, which measures
// double-encoding rather than the cache. Each adapter encodes as its own API
// requires, so the comparison is at the application boundary.
function makeValue(rnd, bytes) {
    const items = [];
    let approx = 40;
    while (approx < bytes) {
        items.push({ k: WORDS[(rnd() * 10) | 0] + ((rnd() * 1e5) | 0), v: (rnd() * 1e6) | 0 });
        approx += 34;
    }
    return { id: WORDS[(rnd() * 10) | 0] + ((rnd() * 1e6) | 0), ts: 1757000000000, items };
}

const SIZES = [200, 400, 800, 1600, 3200];
const sizeFor = i => SIZES[((i * 2654435761) >>> 0) % SIZES.length];

/**
 * Build the request stream ONCE, outside timing. Zipf sampling, key
 * construction and payload generation all cost more than a cache hit, so
 * leaving them in the timed loop measures the harness, not the cache.
 */
function buildPlan(opts) {
    const { ops, nkeys, seed, writeRatio = 0.10 } = opts;
    const rnd = mkRng(seed), pick = mkZipf(nkeys, rnd);
    const keys = new Array(nkeys), vals = new Array(nkeys);
    for (let i = 0; i < nkeys; i++) {
        keys[i] = 'sess:' + i;
        vals[i] = makeValue(mkRng(i * 2654435761), sizeFor(i));
    }
    const idx = new Int32Array(ops);
    const isWrite = new Uint8Array(ops);
    for (let n = 0; n < ops; n++) { idx[n] = pick(); isWrite[n] = rnd() < writeRatio ? 1 : 0; }
    return { keys, vals, idx, isWrite, ops };
}

/**
 * Cache-aside workload: mostly reads, some explicit writes; every miss is
 * followed by a fill. `adapter` is { get, set, sync }.
 */
async function run(adapter, plan, sampleEvery = 256, yieldEvery = 20) {
    const { keys, vals, idx, isWrite, ops } = plan;
    let hits = 0, misses = 0, writes = 0;
    const lat = [];
    const t0 = process.hrtime.bigint();
    for (let n = 0; n < ops; n++) {
        const i = idx[n], k = keys[i];
        const sample = (n % sampleEvery) === 0;
        const ts = sample ? process.hrtime.bigint() : 0n;
        if (isWrite[n]) {
            writes++;
            if (adapter.sync) adapter.set(k, vals[i]); else await adapter.set(k, vals[i]);
        } else {
            const got = adapter.sync ? adapter.get(k) : await adapter.get(k);
            if (got === undefined || got === null) {
                misses++;
                if (adapter.sync) adapter.set(k, vals[i]); else await adapter.set(k, vals[i]);
            } else hits++;
        }
        if (sample) lat.push(Number(process.hrtime.bigint() - ts));
        // A real server turns the event loop constantly between requests. A tight
        // synchronous loop would never let a batched-IPC write path flush, and
        // would flatter any implementation that defers work to a later tick.
        // Applied identically to both caches.
        if (yieldEvery && (n % yieldEvery) === yieldEvery - 1) await new Promise(setImmediate);
    }
    const ns = Number(process.hrtime.bigint() - t0);
    lat.sort((a, b) => a - b);
    const pct = p => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0;
    return {
        ops, ms: ns / 1e6, opsPerSec: ops / (ns / 1e9),
        hits, misses, writes, hitRate: hits / (hits + misses),
        p50: pct(0.50), p99: pct(0.99), p999: pct(0.999)
    };
}

module.exports = { run, buildPlan, mkRng, mkZipf, makeValue, sizeFor, BUGSEE };
