'use strict';
// NOTE: this harness measures the CLUSTER IPC path specifically, so it pins
// transport:'ipc'. Shared memory is the default now; without the pin these
// scripts silently measured the wrong transport and reported nonsense.
// How much of the 60k writes/s cluster-IPC ceiling is SERIALIZATION, and how
// much is the pipe plus the event loop? cluster supports `serialization:
// 'advanced'`, which swaps JSON for the V8 structured serializer -- a one-line
// change. If that alone recovers most of the gap to the arena's 986k/s apply
// rate, a shared-memory ring is not worth building yet.
//
// Both configurations run the identical worker loop back to back, so the ratio
// between them is meaningful even under external CPU load.
const cluster = require('cluster');
const { TurboCache } = require('../src/turbocache');
const ARENA = '/tcipc_' + (process.env.SER || 'json');
const SER = process.env.SER === 'advanced' ? 'advanced' : 'json';
const N = Number(process.env.N || 600000);
const VAL = 'v'.repeat(180);

function slotsFor(bytes) {
    return 1 << Math.max(12, Math.min(22, Math.ceil(Math.log2(Math.max(4096, bytes / 256)))));
}

if (cluster.isPrimary) {
    const L2 = 192 * 1024 * 1024;
    const cache = TurboCache.createPrimary(ARENA, L2, slotsFor(L2), { storage: 'bytes', transport: 'ipc' });

    // Reference: what the arena itself can absorb, no transport involved.
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) cache.set('a:' + i, VAL);
    const applyRate = N / (Number(process.hrtime.bigint() - t0) / 1e9);

    cluster.setupPrimary({ serialization: SER, exec: __filename });
    TurboCache.install(cluster);
    const w = cluster.fork({ TC_ARENA: ARENA });
    let got = 0, t1 = 0, tLast = 0;
    w.on('message', (m) => {
        if (!m) return;
        if (m.t === 'go') { t1 = process.hrtime.bigint(); return; }
        if (m.t === 'done') {
            // Measure to the LAST DELIVERED BATCH, not to the 'done' marker. The
            // worker sleeps 3s after its final flush so late batches can land, and
            // including that idle time in the denominator understated the rate by
            // roughly 5x -- it made every policy look identical at ~60k/s because
            // the constant dominated whatever was being compared.
            const s = Number(tLast - t1) / 1e9;
            console.log(`  ser=${SER.padEnd(8)} window=${(Number(process.env.WINDOW || (8<<20))/1048576).toFixed(2)}MB delivered ${(got / s / 1000).toFixed(0)}k writes/s` +
                        `   (${got} of ${m.offered} offered, ${(100 * m.shed / m.offered).toFixed(1)}% shed)`);
            console.log(`  arena direct apply    ${(applyRate / 1000).toFixed(0)}k writes/s   ` +
                        `transport is ${(applyRate / (got / s)).toFixed(1)}x slower than the arena`);
            w.kill(); cache.close(); process.exit(0);
        }
        if (m.b) { got += m.b.length / 5; tLast = process.hrtime.bigint(); }
    });
} else {
    const cache = TurboCache.attachWorker(ARENA, 1, { storage: 'bytes', l1MaxBytes: 2 << 20, transport: 'ipc',
        maxInFlightBytes: Number(process.env.WINDOW || (8 << 20)) });
    process.send({ t: 'go' });
    let i = 0;
    const CHUNK = 2000;
    (function step() {
        const end = Math.min(i + CHUNK, N);
        for (; i < end; i++) cache.set('b:' + i, VAL);
        if (i < N) return setImmediate(step);
        cache.flush();
        setTimeout(() => process.send({ t: 'done', offered: N, shed: Math.round(cache.stats.writesShed || 0) }), 3000);
    })();
}
