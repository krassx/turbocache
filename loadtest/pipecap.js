'use strict';
// What can the cluster IPC channel actually carry, with no cache in the way?
// This bounds ANY pipe-based transport and tells us whether the 60k writes/s
// ceiling is the channel itself or turbocache's congestion policy sitting on
// top of it. Sends fixed-size payloads, respecting process.send()'s backpressure
// exactly the way turbocache does.
const cluster = require('cluster');
const SER = process.env.SER === 'advanced' ? 'advanced' : 'json';
const SECS = Number(process.env.SECS || 5);
const PAYLOAD = Number(process.env.PAYLOAD || 250 * 5800);   // ~1MB, our outbox cap

if (cluster.isPrimary) {
    cluster.setupPrimary({ serialization: SER, exec: __filename });
    const w = cluster.fork();
    let bytes = 0, msgs = 0, t0 = 0;
    w.on('message', (m) => {
        if (m.t === 'go') { t0 = process.hrtime.bigint(); return; }
        if (m.t === 'end') {
            const s = Number(process.hrtime.bigint() - t0) / 1e9;
            console.log(`  serialization=${SER.padEnd(8)} ${(bytes / s / 1048576).toFixed(0)} MB/s` +
                        `  ${(msgs / s).toFixed(0)} msg/s of ${(PAYLOAD / 1024).toFixed(0)}KB` +
                        `  -> ${((bytes / s) / 250 / 1000).toFixed(0)}k writes/s equivalent at 250B/write`);
            w.kill(); process.exit(0);
        }
        if (m.p) { bytes += m.p.length; msgs++; }
    });
} else {
    const p = 'x'.repeat(PAYLOAD);
    process.send({ t: 'go' });
    const deadline = Date.now() + SECS * 1000;
    let blocked = false;
    (function pump() {
        while (!blocked && Date.now() < deadline) {
            const ok = process.send({ t: 'd', p }, () => { blocked = false; setImmediate(pump); });
            if (ok === false) { blocked = true; return; }
        }
        if (Date.now() >= deadline) { process.send({ t: 'end' }); return; }
        if (!blocked) setImmediate(pump);
    })();
}
