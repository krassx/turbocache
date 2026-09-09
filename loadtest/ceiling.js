'use strict';
// NOTE: this harness measures the CLUSTER IPC path specifically, so it pins
// transport:'ipc'. Shared memory is the default now; without the pin these
// scripts silently measured the wrong transport and reported nonsense.
// Where does the 65% shed rate come from? Two candidates:
//   (a) the primary cannot APPLY writes to the arena fast enough
//   (b) the cluster IPC channel cannot CARRY them fast enough
// These have opposite fixes, so measure them separately.
const cluster = require('cluster');
const { TurboCache } = require('../prototype/turbocache');
const ARENA = process.env.ARENA || '/tcceil';
const L2 = Number(process.env.L2 || 192 * 1024 * 1024);
const N = Number(process.env.N || 400000);
const VAL = 'v'.repeat(180);

if (cluster.isPrimary) {
    const cache = TurboCache.createPrimary(ARENA, L2, 1 << 18, { storage: 'bytes', transport: 'ipc' });

    // (a) apply ceiling: primary writes straight into the arena, no IPC at all.
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) cache.set('a:' + i, VAL);
    let secs = Number(process.hrtime.bigint() - t0) / 1e9;
    const applyRate = N / secs;
    console.log(`  (a) primary direct apply    ${(applyRate / 1000).toFixed(0)}k writes/s  (${N} in ${secs.toFixed(2)}s)`);

    // (b) channel ceiling: one worker sends the same volume over IPC; the primary
    // applies each batch as it lands. Difference from (a) is the transport.
    cluster.setupPrimary({ exec: __filename });
    const w = cluster.fork({ ROLE: 'w' });
    let got = 0, wt0 = 0;
    w.on('message', (m) => {
        if (m.t === 'go') { wt0 = process.hrtime.bigint(); return; }
        if (m.t === 'done') {
            const s = Number(process.hrtime.bigint() - wt0) / 1e9;
            console.log(`  (b) via cluster IPC        ${(got / s / 1000).toFixed(0)}k writes/s  (${got} delivered in ${s.toFixed(2)}s)`);
            console.log(`      offered ${m.offered}, shed ${m.shed} (${(100 * m.shed / Math.max(1, m.offered)).toFixed(1)}%)`);
            const verdict = got / Math.max(1, applyRate) > 0.85
                ? 'IPC keeps up with the primary -- the ceiling is the single-writer APPLY rate'
                : 'IPC delivers well under the apply rate -- the ceiling is the CHANNEL';
            console.log(`  verdict: ${verdict}`);
            w.kill(); cache.close(); process.exit(0);
        }
        got += m.b ? m.b.length / 5 : 0;
    });
} else {
    const cache = TurboCache.attachWorker(ARENA, 1, { storage: 'bytes', l1MaxBytes: 2 << 20, transport: 'ipc' });
    process.send({ t: 'go' });
    // Yield between chunks. The L2 write path is asynchronous by construction:
    // process.send() queues into libuv and the drain callback that clears our
    // congestion flag can only fire when the event loop turns. A fully
    // synchronous burst of 400k sets therefore delivers almost nothing (measured
    // 4486 of 400000, 97.9% shed) no matter how fast the primary is -- that is a
    // property of the write path, not a channel throughput number. A real server
    // returns to the loop between requests, so measure it that way.
    let i = 0;
    const CHUNK = 2000;
    (function step() {
        const end = Math.min(i + CHUNK, N);
        for (; i < end; i++) cache.set('b:' + i, VAL);
        if (i < N) return setImmediate(step);
        cache.flush();
        setTimeout(() => process.send({
            t: 'done', offered: N, shed: Math.round(cache.stats.writesShed || 0),
        }), 3000);
    })();
}
