'use strict';
// Honest L2 hit latency. The earlier number cycled 2000 keys IN ORDER, so the
// index and entries (~200KB) stayed cache-resident - a warm, sequential best
// case, not what a real keyspace does.
const { TurboCache } = require('../prototype/turbocache');
const native = require('../prototype/build/Release/l2.node');
let seq = 0;
console.log('  values  keyspace   order        L2 hit (getLen, no JS string)   full get()');
for (const bytes of [64, 1024]) {
    for (const [nkeys, arena] of [[2000, 64 << 20], [200000, 512 << 20]]) {
        const c = TurboCache.createPrimary('/tcl2' + process.pid + '_' + (seq++), arena, 1 << 20,
            { storage: 'bytes', l1MaxBytes: 4096 });     // L1 tiny: measure L2
        const val = 'x'.repeat(bytes);
        const keys = Array.from({ length: nkeys }, (_, i) => 'key:' + i);
        for (const k of keys) c.set(k, val);
        const idx = Array.from({ length: 200000 }, (_, i) => i % nkeys);
        const rnd = idx.slice(); for (let i = rnd.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0; [rnd[i], rnd[j]] = [rnd[j], rnd[i]]; }
        const run = (order, fn) => {
            for (let i = 0; i < 20000; i++) fn(keys[order[i % order.length]]);
            const t = process.hrtime.bigint();
            for (let i = 0; i < order.length; i++) fn(keys[order[i]]);
            return Number(process.hrtime.bigint() - t) / order.length;
        };
        for (const [label, order] of [['sequential', idx], ['random', rnd]]) {
            const l2 = run(order, k => native.getLen(k));
            const full = run(order, k => native.get(k));
            console.log(`  ${String(bytes).padStart(6)}B ${String(nkeys).padStart(9)} ${label.padEnd(12)}` +
                `${l2.toFixed(0).padStart(20)}ns ${full.toFixed(0).padStart(16)}ns`);
        }
        TurboCache.native().destroy();
    }
}
