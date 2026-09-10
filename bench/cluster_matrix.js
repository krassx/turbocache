'use strict';
// 1 primary + N workers over a SHARED keyspace, so workers genuinely interfere:
// each worker's writes invalidate the others' L1 copies, and every L1 miss must
// cross the process boundary — IPC for bugsee, shared memory for turbocache.
const cluster = require('cluster');
const { run, buildPlan, BUGSEE } = require('./workload');
const { turboOpts, turboAdapter, bugseeAdapter } = require('./adapters');

const IMPL    = process.env.IMPL || 'turbo';      // turbo | bugsee
const MODE    = process.env.MODE || 'bytes';      // bytes | direct | safe
const WORKERS = Number(process.env.WORKERS || 4);
const OPS     = Number(process.env.OPS || 120000);
const NKEYS   = Number(process.env.NKEYS || 60000);
const WRITE   = Number(process.env.WRITE || 0.10);
const L1 = 2 << 20, L2 = 256 << 20;
const ARENA = '/tccm' + process.pid;

if (cluster.isPrimary) {
    let srv = null;
    if (IMPL === 'turbo') {
        const { TurboCache } = require('../src/turbocache');
        TurboCache.createPrimary(ARENA, L2, 1 << 20, turboOpts(MODE, L1));
        process.env.TC_ARENA = ARENA;
        TurboCache.install(cluster);
    } else {
        srv = new (require(BUGSEE).IpcServer)({ maxBytes: L2 });
        const h = srv.createOnMessage();
        cluster.on('online', w => w.on('message', m => h.call(w, m)));
    }
    Object.assign(process.env, { IMPL, MODE });

    const results = [];
    const t0 = Date.now();
    for (let i = 0; i < WORKERS; i++) cluster.fork({ WORKER_ID: String(i + 1) });
    cluster.on('message', (w, m) => {
        if (!m || m.t !== 'result') return;
        results.push(m.r);
        if (results.length < WORKERS) return;
        const wall = Date.now() - t0;
        const agg = results.reduce((a, r) => a + r.opsPerSec, 0);
        const hits = results.reduce((a, r) => a + r.hits, 0);
        const miss = results.reduce((a, r) => a + r.misses, 0);
        const p = k => Math.round(results.reduce((a, r) => a + r[k], 0) / results.length);
        console.log(`${(IMPL === 'turbo' ? 'turbo/' + MODE : 'bugsee').padEnd(14)}` +
            `${(agg / 1000).toFixed(0).padStart(7)}k ops/s   hit ${(100 * hits / (hits + miss)).toFixed(1).padStart(5)}%` +
            `   p50 ${String(p('p50')).padStart(6)}ns  p99 ${String(p('p99')).padStart(7)}ns  p99.9 ${String(p('p999')).padStart(8)}ns` +
            `   wall ${wall}ms`);
        for (const id in cluster.workers) cluster.workers[id].kill();
        process.exit(0);
    });
} else {
    (async () => {
        const id = Number(process.env.WORKER_ID);
        let adapter;
        if (IMPL === 'turbo') {
            const { TurboCache } = require('../src/turbocache');
            const c = TurboCache.attachWorker(process.env.TC_ARENA, id, turboOpts(MODE, L1));
            adapter = turboAdapter(MODE, c);
            adapter._flush = () => c.flush();
        } else {
            adapter = bugseeAdapter(new (require(BUGSEE).Cache)({ l1MaxBytes: L1 }));
        }
        // different seeds over the SAME keyspace: heavy overlap between workers
        const plan = buildPlan({ ops: OPS, nkeys: NKEYS, seed: 1000 + id * 7919, writeRatio: WRITE });
        const r = await run(adapter, plan, 256, 20);
        if (adapter._flush) adapter._flush();
        setTimeout(() => process.send({ t: 'result', r }), 150);
    })();
}
