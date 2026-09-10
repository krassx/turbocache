'use strict';
// process.send() is not turbocache's private pipe -- it is THE cluster channel,
// shared with the application's own worker<->primary messaging and with any
// other library using it. This measures the externality directly: an app-level
// ping/pong round trip on that channel, first with the cache idle, then with the
// cache under write load on the same channel.
//
// Anything the second phase adds is latency turbocache imposes on code that has
// nothing to do with the cache.
const cluster = require('cluster');
const { TurboCache } = require('../src/turbocache');
const ARENA = '/tcshare';
const SECS = Number(process.env.SECS || 8);
const VAL = 'v'.repeat(180);
function slotsFor(b) { return 1 << Math.max(12, Math.min(22, Math.ceil(Math.log2(Math.max(4096, b / 256))))); }
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p / 100))] : 0;

if (cluster.isPrimary) {
    const L2 = 192 * 1024 * 1024;
    const cache = TurboCache.createPrimary(ARENA, L2, slotsFor(L2), { storage: 'bytes', transport: 'ipc' });
    TurboCache.install(cluster);
    const w = cluster.fork({ TC_ARENA: ARENA });
    // The primary answers app pings immediately; the worker times the round trip.
    w.on('message', (m) => { if (m && m.t === 'ping') w.send({ t: 'pong', s: m.s }); });
    w.on('message', (m) => {
        if (!m || m.t !== 'result') return;
        for (const r of m.rows) {
            console.log(`  ${r.label.padEnd(22)} p50 ${(r.p50/1000).toFixed(2)}ms  p99 ${(r.p99/1000).toFixed(2)}ms` +
                        `  p99.9 ${(r.p999/1000).toFixed(2)}ms  max ${(r.max/1000).toFixed(1)}ms   (${r.n} pings)`);
        }
        const [idle, shed, send] = m.rows;
        console.log(`\n  worker CPU effect (shedding vs idle)   p50 ${(idle.p50/1000).toFixed(2)}ms -> ${(shed.p50/1000).toFixed(2)}ms`);
        console.log(`  CHANNEL effect  (sending vs shedding)  p50 ${(shed.p50/1000).toFixed(2)}ms -> ${(send.p50/1000).toFixed(2)}ms` +
                    `  = ${(send.p50/Math.max(0.001, shed.p50)).toFixed(1)}x`);
        console.log(`  CHANNEL effect at p99                  ${(shed.p99/1000).toFixed(2)}ms -> ${(send.p99/1000).toFixed(2)}ms` +
                    `  = ${(send.p99/Math.max(0.001, shed.p99)).toFixed(1)}x`);
        console.log(`  ping throughput                        ${(idle.n/idle.secs/1000).toFixed(0)}k/s idle, ` +
                    `${(shed.n/shed.secs/1000).toFixed(1)}k/s shedding, ${(send.n/send.secs/1000).toFixed(1)}k/s sending`);
        w.kill(); cache.close(); process.exit(0);
    });
} else {
    // Two caches over the same arena: `sending` uses the shared cluster channel,
    // `shedding` does byte-for-byte the same set() work but its send window is 0
    // so nothing ever reaches the channel. The difference between the two phases
    // is therefore the CHANNEL cost alone, with the worker's own CPU cost for
    // encoding and L1 held constant. Without that control, a slower app ping just
    // measures the worker being busy.
    const sending = TurboCache.attachWorker(ARENA, 1, { storage: 'bytes', l1MaxBytes: 2 << 20, transport: 'ipc' });
    // maxInFlightBytes 0 really means 0 now (`??`, not `||`), so this control
    // genuinely never reaches the channel. It previously got the 8MB default,
    // making the control identical to the phase it was controlling.
    const shedding = TurboCache.attachWorker(ARENA, 1, { storage: 'bytes', l1MaxBytes: 2 << 20, transport: 'ipc', maxInFlightBytes: 0 });
    const rows = [];
    let seq = 0, sentAt = new Map(), lat = [], writing = false, wi = 0;

    process.on('message', (m) => {
        if (!m || m.t !== 'pong') return;
        const t = sentAt.get(m.s); sentAt.delete(m.s);
        if (t !== undefined) lat.push(Number(process.hrtime.bigint() - t) / 1000);   // us
    });
    function ping() { const s = ++seq; sentAt.set(s, process.hrtime.bigint()); process.send({ t: 'ping', s }); }

    // App traffic runs at a steady, modest rate in both phases: 1 ping per
    // immediate turn. Only the cache load differs between them.
    function phase(label, target, done) {
        lat = []; sentAt.clear();
        const end = Date.now() + SECS * 1000;
        (function turn() {
            ping();
            if (target) for (let k = 0; k < 400; k++) target.set('w:' + (wi++), VAL);
            if (Date.now() < end) return setImmediate(turn);
            setTimeout(() => {
                const s = lat.slice().sort((x, y) => x - y);
                rows.push({ label, n: s.length, secs: SECS, p50: pct(s, 50), p99: pct(s, 99), p999: pct(s, 99.9), max: s[s.length - 1] || 0 });
                done();
            }, 500);
        })();
    }
    phase('cache idle', null, () =>
        phase('writing, NOT sending', shedding, () =>
            phase('writing AND sending', sending, () => process.send({ t: 'result', rows }))));
}
