'use strict';
// 1 primary + N workers, shared keyspace so workers genuinely interfere:
// every worker's write invalidates the other workers' L1 copies, and misses
// must cross the process boundary (IPC for bugsee, shared memory for turbocache).
const cluster = require('cluster');
const os = require('os');
const { run, buildPlan, BUGSEE } = require('./workload');

const IMPL    = (process.env.IMPL || 'turbo');
const WORKERS = Number(process.env.WORKERS || 4);
const OPS     = Number(process.env.OPS || 150000);
const NKEYS   = Number(process.env.NKEYS || 60000);
const MODE    = process.env.MODE || 'object';       // object | string | codec
const JSONC = { encode: JSON.stringify, decode: JSON.parse };
const L1 = 2 * 1024 * 1024;
const L2 = 256 * 1024 * 1024;
const ARENA = '/tc-cluster-' + process.pid;

function jsonAdapter(impl, c) {
    if (impl === 'turbo') {
        // 'codec': the cache owns encode/decode so L1 holds decoded objects.
        // 'string'/'codec' both pass values straight through the adapter.
        return (MODE === 'string' || MODE === 'codec')
            ? { sync: true, get: k => c.get(k), set: (k, v) => c.set(k, v) }
            : { sync: true,
                get: k => { const s = c.get(k); return s === undefined ? undefined : JSON.parse(s); },
                set: (k, v) => c.set(k, JSON.stringify(v)) };
    }
    return { sync: false, get: k => c.get(k), set: (k, v) => c.set(k, v) };
}

if (cluster.isPrimary) {
    console.log(`cluster: 1 primary + ${WORKERS} workers | impl=${IMPL} | values=${MODE}`);
    console.log(`${OPS} ops/worker, ${NKEYS}-key SHARED keyspace, zipf s=1.0, 90/10 read/write`);
    console.log(`sizes: L1=${L1/1048576}MB per worker, L2=${L2/1048576}MB shared\n`);

    let applyBatch = null;
    if (IMPL === 'turbo') {
        const { TurboCache } = require('../src/turbocache');
        TurboCache.createPrimary(ARENA, L2, 1 << 20);       // must exist before fork
        process.env.TC_ARENA = ARENA;
        applyBatch = TurboCache.applyBatch;
        var isCacheMsg = TurboCache.isCacheMessage;
    } else {
        // Construct IpcServer directly (rather than createMasterHandler) so the
        // benchmark can read L2 occupancy afterwards and tell saturation apart
        // from a misconfigured cache.
        var srv = new (require(BUGSEE).IpcServer)({ maxBytes: L2 });
        var bugseeMaster = srv.createOnMessage();
    }
    process.env.IMPL = IMPL; process.env.MODE = MODE;

    const results = [];
    let applied = 0;
    const t0 = Date.now();
    for (let i = 0; i < WORKERS; i++) {
        const w = cluster.fork({ WORKER_ID: String(i + 1) });
        w.on('message', function (m) {
            if (m && m.t === 'result') { results.push(m.r); if (results.length === WORKERS) finish(); return; }
            if (IMPL === 'turbo') { if (isCacheMsg(m)) { applied++; applyBatch(m); } }
            else bugseeMaster.call(w, m);
        });
    }

    function finish() {
        const wall = Date.now() - t0;
        const tot = results.reduce((a, r) => ({
            ops: a.ops + r.ops, hits: a.hits + r.hits, misses: a.misses + r.misses,
            writes: a.writes + r.writes
        }), { ops: 0, hits: 0, misses: 0, writes: 0 });
        const aggOps = results.reduce((a, r) => a + r.opsPerSec, 0);
        const p50 = Math.round(results.reduce((a, r) => a + r.p50, 0) / results.length);
        const p99 = Math.round(results.reduce((a, r) => a + r.p99, 0) / results.length);
        const p999 = Math.round(results.reduce((a, r) => a + r.p999, 0) / results.length);
        console.log(`  aggregate throughput : ${(aggOps/1000).toFixed(0)}k ops/s`);
        console.log(`  wall clock           : ${wall}ms`);
        console.log(`  hit rate             : ${(100*tot.hits/(tot.hits+tot.misses)).toFixed(1)}%  (${tot.hits} hits / ${tot.misses} misses)`);
        console.log(`  writes               : ${tot.writes}`);
        console.log(`  latency ns (avg of workers): p50=${p50}  p99=${p99}  p99.9=${p999}`);
        if (IMPL === 'turbo') {
            const st = require('../src/turbocache').TurboCache.native().stats();
            console.log(`  primary applied ${applied} IPC batches; L2 holds ${st.live} entries`);
        } else {
            console.log(`  primary L2 holds ${srv.l2.itemCount} entries, ${(srv.l2.length/1048576).toFixed(1)}MB of ${L2/1048576}MB`);
        }
        for (const id in cluster.workers) cluster.workers[id].kill();
        process.exit(0);
    }
} else {
    (async () => {
        const id = Number(process.env.WORKER_ID);
        let c;
        if (IMPL === 'turbo') {
            const { TurboCache } = require('../src/turbocache');
            // Was passing codec:null with no storage preset, which selects the
            // un-nameable "raw" mode and skips the flatten that 'primitives'
            // pays - so the headline number omitted ~20% of the default mode's
            // cost. Use the real presets.
            c = TurboCache.attachWorker(process.env.TC_ARENA, id, MODE === 'codec'
                ? { l1MaxBytes: L1, codec: JSONC }
                : { l1MaxBytes: L1, storage: 'bytes' });
        } else {
            c = new (require(BUGSEE).Cache)({ l1MaxBytes: L1 });
        }
        // Different seeds over the SAME keyspace: workers overlap heavily, so
        // writes from one invalidate the others - the cross-process traffic the
        // test is meant to generate.
        const plan = buildPlan({ ops: OPS, nkeys: NKEYS, seed: 1000 + id * 7919 });
        if (MODE === 'string') for (let i = 0; i < plan.vals.length; i++) plan.vals[i] = JSON.stringify(plan.vals[i]);
        const r = await run(jsonAdapter(IMPL, c), plan);
        if (IMPL === 'turbo') c.flush();
        setTimeout(() => process.send({ t: 'result', r }), 100);
    })();
}
