'use strict';
// Async-flow test.
//
// load.js drives the cache from tight synchronous loops, which answers "how
// fast" but not "how well does it behave inside a real server". A server
// interleaves cache reads with awaits, unrelated logic, and garbage collection.
// The questions here are different:
//
//   1. does a cache read ever BLOCK the event loop, and for how long?
//   2. what does GC do to read latency, and how much GC does the cache cause?
//   3. do values stay correct when reads interleave with awaits and propagation?
//
// Every measurement runs twice per worker -- once against a NO-OP cache, once
// against the real one -- because event-loop delay and GC pauses exist in the
// harness regardless. Only the difference between the two phases is the cache.
const cluster = require('cluster');
const os = require('os');
const { monitorEventLoopDelay, PerformanceObserver, constants } = require('perf_hooks');
const { TurboCache } = require('../src/turbocache');

const WORKERS = Number(process.env.WORKERS || 4);
const SECONDS = Number(process.env.SECONDS || 60);
const CONC    = Number(process.env.CONC || 64);      // in-flight requests per worker
const HOT     = Number(process.env.HOT || 300);
const COLD    = Number(process.env.COLD || 200000);
const SHARED  = Number(process.env.SHARED || 500);
const L1      = Number(process.env.L1 || 2 * 1024 * 1024);
const L2      = Number(process.env.L2 || 192 * 1024 * 1024);
const MODE    = process.env.MODE || 'bytes';
const ARENA   = '/tcasync_' + MODE;

// Index slots must scale with the arena: a 1M-slot index is itself ~16MB, which
// a small arena cannot hold, and create() rightly refuses. Size it from L2 at
// roughly one slot per 256 bytes of data, rounded to a power of two.
function slotsFor(bytes) {
    return 1 << Math.max(12, Math.min(22, Math.ceil(Math.log2(Math.max(4096, bytes / 256)))));
}

function makeVal(key, ver) {
    const len = 64 + (ver * 37) % 700;
    const filler = String.fromCharCode(97 + (ver % 26)).repeat(len);
    if (MODE === 'bytes') return `${key}#${ver}#${filler}`;
    return { k: key, v: ver, n: ver * 1.5, ok: (ver & 1) === 0, tags: [key, ver], body: filler };
}
function verify(key, val) {
    if (MODE === 'bytes') {
        if (typeof val !== 'string') return 'not-a-string';
        const p = val.indexOf('#'), q = val.indexOf('#', p + 1);
        if (p < 0 || q < 0 || val.slice(0, p) !== key) return 'key-mismatch';
        const ver = Number(val.slice(p + 1, q));
        return Number.isInteger(ver) && val === makeVal(key, ver) ? null : 'payload-mismatch';
    }
    if (val === null || typeof val !== 'object') return 'not-an-object';
    if (val.k !== key) return 'key-mismatch';
    if (!Number.isInteger(val.v)) return 'bad-version';
    const want = makeVal(key, val.v);
    return (val.n === want.n && val.ok === want.ok && val.body === want.body &&
            Array.isArray(val.tags) && val.tags[1] === val.v) ? null : 'payload-mismatch';
}

const mergeLat = (rows) => {
    const all = [];
    for (const r of rows) if (r.lat) for (const v of r.lat) all.push(v);
    return all.sort((a, b) => a - b);
};
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))] : 0;

if (cluster.isPrimary) {
    console.log(`turbocache async-flow test — ${WORKERS} workers x ${CONC} in-flight, ${SECONDS}s/phase, storage=${MODE}`);
    console.log(`  node ${process.version} on ${os.platform()}/${os.arch()}, ${os.cpus().length} cpus\n`);
    const cache = TurboCache.createPrimary(ARENA, L2, slotsFor(L2), { storage: MODE, l1MaxBytes: L1 });
    for (let i = 0; i < COLD; i++) cache.set('cold:' + i, makeVal('cold:' + i, 1));
    for (let i = 0; i < HOT; i++) cache.set('hot:' + i, makeVal('hot:' + i, 1));
    for (let i = 0; i < SHARED; i++) cache.set('shared:' + i, makeVal('shared:' + i, 1));
    console.log(`  seeded, arena live=${TurboCache.arenaStats().live}\n`);

    TurboCache.install(cluster);          // primary must drain worker write batches
    const got = [];
    for (let i = 0; i < WORKERS; i++) cluster.fork({ WORKER_ID: i + 1, TC_ARENA: ARENA })   // ids are 1-based; 0 means primary;
    cluster.on('message', (w, m) => {
        if (!m || m.t !== 'phases') return;
        got.push(m);
        console.log(`  worker ${m.id} done (${got.length}/${WORKERS})`);
        if (got.length === WORKERS) report(got);
    });
    function agg(rows, k, how) {
        const v = rows.map(r => r[k]);
        return how === 'max' ? Math.max(...v) : how === 'sum' ? v.reduce((a, b) => a + b, 0)
             : v.reduce((a, b) => a + b, 0) / v.length;
    }
    function report(all) {
        const secs = SECONDS;
        for (const phase of ['baseline', 'cached']) {
            const rows = all.map(r => r[phase]);
            console.log(`  --- ${phase === 'baseline' ? 'BASELINE (no-op cache, same harness)' : `CACHED (storage=${MODE})`} ---`);
            console.log(`  requests/s             ${(agg(rows,'reqs','sum')/secs/1000).toFixed(0)}k    cache ops/s ${(agg(rows,'ops','sum')/secs/1000).toFixed(0)}k`);
            // A per-process histogram cannot be merged across processes, so the p99
            // is the WORST worker's, not an average of theirs -- averaging would
            // hide the one worker that is actually stalling.
            console.log(`  event loop delay       mean ${agg(rows,'loopMean','avg').toFixed(2)}ms` +
                        `  p99 ${agg(rows,'loopP99','max').toFixed(2)}ms (worst worker)` +
                        `  max ${agg(rows,'loopMax','max').toFixed(2)}ms`);
            // Per-request, not absolute: the baseline runs several times faster
            // than the cached phase, so it produces proportionally more harness
            // garbage. Comparing raw GC totals across phases compares throughput,
            // not the cache.
            const reqs = agg(rows,'reqs','sum');
            console.log(`  gc                     ${agg(rows,'gcN','sum').toFixed(0)} cycles, ${agg(rows,'gcMs','sum').toFixed(0)}ms total, longest pause ${agg(rows,'gcMax','max').toFixed(2)}ms, major ${agg(rows,'gcMajor','sum').toFixed(0)}`);
            console.log(`  gc per 1M requests     ${(1e6*agg(rows,'gcMs','sum')/reqs).toFixed(1)}ms  (${(1e6*agg(rows,'gcN','sum')/reqs).toFixed(0)} cycles)`);
            const m = mergeLat(rows);
            console.log(`  sampled get latency    p50 ${pct(m,50).toFixed(0)}ns  p99 ${pct(m,99).toFixed(0)}ns` +
                        `  p99.9 ${pct(m,99.9).toFixed(0)}ns  max ${((m[m.length-1]||0)/1000).toFixed(1)}us` +
                        `  (${m.length.toLocaleString()} samples merged)`);
            console.log(`  wrong values           ${agg(rows,'wrong','sum')}`);
        }
        const b = all.map(r => r.baseline), c = all.map(r => r.cached);
        const dLoop = agg(c,'loopP99','max') - agg(b,'loopP99','max');
        const gcPer = (rows) => 1e6 * agg(rows,'gcMs','sum') / agg(rows,'reqs','sum');
        const dGc   = gcPer(c) - gcPer(b);
        console.log(`\n  --- attribution (cached minus baseline) ---`);
        console.log(`  event loop p99 delta   ${dLoop >= 0 ? '+' : ''}${dLoop.toFixed(2)}ms  <- blocking the cache adds to the loop`);
        console.log(`  gc per 1M req delta    ${dGc >= 0 ? '+' : ''}${dGc.toFixed(1)}ms  ` +
                    `(${gcPer(b).toFixed(1)}ms baseline -> ${gcPer(c).toFixed(1)}ms cached)`);
        console.log(`  longest single stall   ${((mergeLat(c).pop()||0)/1000).toFixed(1)}us worst get,` +
                    ` ${agg(c,'loopMax','max').toFixed(1)}ms worst loop delay`);
        const wrong = agg(c,'wrong','sum') + agg(b,'wrong','sum');
        const pass = wrong === 0 && agg(c,'loopP99','max') < 50;
        console.log(`\n  ${pass ? 'PASS' : 'FAIL'}${wrong ? ` (${wrong} wrong values)` : ''}`);
        for (const id in cluster.workers) cluster.workers[id].kill();
        cache.close();
        process.exit(pass ? 0 : 1);
    }
} else {
    const id = Number(process.env.WORKER_ID);
    const real = TurboCache.attachWorker(ARENA, id, { storage: MODE, l1MaxBytes: L1 });
    const noop = { get: () => undefined, set: () => true, flush: () => {} };

    let gcMs = 0, gcN = 0, gcMax = 0, gcMajor = 0;
    new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
            gcMs += e.duration; gcN++;
            if (e.duration > gcMax) gcMax = e.duration;
            if (e.detail && e.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) gcMajor++;
        }
    }).observe({ entryTypes: ['gc'] });

    async function phase(cache, seconds) {
        const h = monitorEventLoopDelay({ resolution: 5 });
        let ops = 0, reqs = 0, wrong = 0, ver = 1, sink = 0;
        const lat = [];
        const deadline = Date.now() + seconds * 1000;

        // One "request": an async boundary, some unrelated work that produces
        // garbage, a handful of cache reads, an occasional write. This is the
        // shape that matters -- reads separated by awaits, not back to back.
        async function request(n) {
            await new Promise(r => setImmediate(r));
            const junk = [];
            for (let j = 0; j < 24; j++) junk.push({ n, j, s: 'x'.repeat(40) });
            const sample = (n & 15) === 0;
            for (let k = 0; k < 8; k++) {
                const r = Math.random();
                const key = r < 0.5 ? 'hot:' + ((Math.random() * HOT) | 0)
                          : r < 0.85 ? 'cold:' + ((Math.random() * COLD) | 0)
                          : 'shared:' + ((Math.random() * SHARED) | 0);
                let v;
                if (sample && k === 0) {
                    const t0 = process.hrtime.bigint();
                    v = cache.get(key);
                    lat.push(Number(process.hrtime.bigint() - t0));
                } else v = cache.get(key);
                ops++;
                if (v !== undefined) { if (verify(key, v)) wrong++; }
                else if (cache !== noop) cache.set(key, makeVal(key, 1));
            }
            await null;                                   // microtask boundary
            if ((n & 7) === 0) {
                const k = (n & 15) === 0 ? 'shared:' + ((Math.random() * SHARED) | 0)
                                         : `own:${id}:` + ((Math.random() * 1000) | 0);
                cache.set(k, makeVal(k, ++ver)); ops++;
            }
            sink += junk.length;
            reqs++;
        }

        h.enable();
        let n = 0;
        // Distinguishes "slow" from "wedged": if ops stops advancing the cache is
        // stuck inside a synchronous call; if this timer never fires at all, the
        // event loop itself is blocked.
        const tick = setInterval(() => console.log(`    w${id} alive: reqs=${reqs} ops=${ops} n=${n}`), 1000);
        await Promise.all(Array.from({ length: CONC }, async () => {
            while (Date.now() < deadline) await request(n++);
        }));
        clearInterval(tick);
        h.disable();
        await new Promise(r => setTimeout(r, 50));        // let the gc observer flush
        lat.sort((a, b) => a - b);
        const out = {
            reqs, ops, wrong: wrong + (sink < 0 ? 1 : 0),
            loopMean: h.mean / 1e6, loopP99: h.percentile(99) / 1e6, loopMax: h.max / 1e6,
            gcMs, gcN, gcMax, gcMajor,
            // Ship the SAMPLES, not this worker's percentiles. A mean of four
            // workers' p99s is not a p99: with one worker carrying a heavier
            // tail, avg-of-p99 read 8,836ns where the true merged p99 was
            // 15,337ns -- 42% low, and low in exactly the case you are looking
            // for. Sent once, after the measured window, so the cost is nil.
            lat,
        };
        gcMs = 0; gcN = 0; gcMax = 0; gcMajor = 0;
        return out;
    }

    (async () => {
        console.log(`  worker ${id} starting baseline phase`);
        const baseline = await phase(noop, SECONDS);
        console.log(`  worker ${id} baseline done, starting cached phase`);
        const cached = await phase(real, SECONDS);
        console.log(`  worker ${id} cached done`);
        process.send({ t: 'phases', id, baseline, cached });
        await new Promise(r => setTimeout(r, 60000));
    })().catch(e => { console.error(`  worker ${id} FAILED:`, e); process.exit(1); });
}
