'use strict';
// Does shared-memory submission actually deliver what it promised? Two things
// matter, and they are different:
//   1. delivered writes/s  -- throughput
//   2. the worker's EVENT LOOP DELAY -- the stall that motivated the change.
//      process.send freezes the sender for 0.49ms p50 / 1.15ms p99 per ~525KB
//      batch, and everything else that worker is doing waits behind it.
const cluster = require('cluster');
const { monitorEventLoopDelay } = require('perf_hooks');
const { TurboCache } = require('../src/turbocache');
const T = process.env.T === 'ipc' ? 'ipc' : 'shm';
const ARENA = '/tctb_' + T;
const N = Number(process.env.N || 800000);
const VAL = 'v'.repeat(180);
function slotsFor(b) { return 1 << Math.max(12, Math.min(22, Math.ceil(Math.log2(Math.max(4096, b / 256))))); }

if (cluster.isPrimary) {
    const L2 = 192 * 1024 * 1024;
    const cache = TurboCache.createPrimary(ARENA, L2, slotsFor(L2), { storage: 'bytes', transport: T });
    TurboCache.install(cluster);
    const w = cluster.fork({ TC_ARENA: ARENA, T });
    let t0 = 0, tLast = 0, applied0 = 0;
    w.on('message', (m) => {
        if (!m) return;
        if (m.t === 'go') { t0 = process.hrtime.bigint(); return; }
        if (m.t === 'done') {
            setTimeout(() => {
                TurboCache.drainSubmissions(1 << 22);
                const st = TurboCache.arenaStats();
                if (!tLast) { console.log('  no delivery observed; cannot measure'); process.exit(1); }
                const secs = Number(tLast - t0) / 1e9;
                console.log(`  transport=${T.padEnd(4)}  delivered ${(m.delivered / secs / 1000).toFixed(0)}k writes/s` +
                            `  (${m.delivered} of ${N}, ${(100 * m.shed / N).toFixed(1)}% shed)`);
                console.log(`  worker event loop     mean ${m.loopMean.toFixed(2)}ms  p99 ${m.loopP99.toFixed(2)}ms  max ${m.loopMax.toFixed(2)}ms`);
                console.log(`  arena live=${st.live}`);
                w.kill(); cache.close(); process.exit(0);
            }, 800);
            return;
        }
        if (m.b) tLast = process.hrtime.bigint();
    });
    // shm path: the doorbell wakes us; also drain opportunistically.
    // Only advance tLast when work actually LANDS. Bumping it from the timer
    // regardless of activity put the worker's 400ms wait and the primary's 800ms
    // settle into the denominator -- the same error class already fixed in
    // ipcmodes.js, and it understated both transports.
    setInterval(() => { if (TurboCache.drainSubmissions(8192) > 0) tLast = process.hrtime.bigint(); }, 1).unref();
} else {
    const cache = TurboCache.attachWorker(ARENA, 1, { storage: 'bytes', l1MaxBytes: 2 << 20, transport: process.env.T });
    const h = monitorEventLoopDelay({ resolution: 1 });
    process.send({ t: 'go' });
    h.enable();
    let i = 0;
    const CHUNK = 2000;
    (function step() {
        const end = Math.min(i + CHUNK, N);
        for (; i < end; i++) cache.set('t:' + i, VAL);
        if (i < N) return setImmediate(step);
        cache.flush();
        setTimeout(() => {
            h.disable();
            const shed = Math.round(cache.stats.writesShed || 0);
            process.send({ t: 'done', delivered: N - shed, shed,
                loopMean: h.mean / 1e6, loopP99: h.percentile(99) / 1e6, loopMax: h.max / 1e6 });
        }, 400);
    })();
}
