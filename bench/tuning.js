'use strict';
// What should the second-chance budget and the ring capacity actually be?
const { TurboCache } = require('../prototype/turbocache');
const native = require('../prototype/build/Release/l2.node');
const { buildPlan, run } = require('./workload');

let seq = 0;
const mk = o => TurboCache.createPrimary('/tctune' + process.pid + '_' + (seq++), 64 << 20, 1 << 18,
    { storage: 'bytes', l1MaxBytes: 256 * 1024, ...o });

(async () => {
    console.log('=== second-chance budget: what does capping re-appends cost or buy? ===');
    console.log('  (L1 kept small so the arena, not L1, decides the hit rate)\n');
    console.log('  budget   hit rate   ops/s     set p50   arena evictions');
    const plan = buildPlan({ ops: 200000, nkeys: 40000, seed: 21 });
    const strs = { ...plan, vals: plan.vals.map(v => JSON.stringify(v)) };
    for (const budget of [0, 1, 8, 32, 64, 256, 1024, 8192]) {
        const c = mk({});
        native.secondChanceBudget(budget);
        const r = await run({ sync: true, get: k => c.get(k), set: (k, v) => c.set(k, v) }, strs, 256, 0);
        const st = native.stats();
        console.log(`  ${String(budget).padStart(6)} ${(r.hitRate * 100).toFixed(1).padStart(9)}%` +
            ` ${(r.opsPerSec / 1000).toFixed(0).padStart(7)}k ${String(r.p50).padStart(9)}ns` +
            ` ${String(st.evictions).padStart(16)}`);
        TurboCache.native().destroy();
    }
    native.secondChanceBudget(64);

    console.log('\n=== ring capacity: the ring is appended ONLY by the primary ===');
    console.log('  So its rate is bounded by the primary apply throughput, not by worker count.');
    console.log('  A worker loses records - and must flush its ENTIRE L1 - if the head');
    console.log('  advances more than the ring capacity between two of its drains.\n');
    {
        const c = mk({});
        const N = 300000;
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < N; i++) c.set('k' + (i % 20000), 'v' + i);
        const rate = N / (Number(process.hrtime.bigint() - t0) / 1e9);
        TurboCache.native().destroy();
        console.log(`  primary apply rate: ${(rate / 1000).toFixed(0)}k records/s\n`);
        console.log('  ring size   bytes    survives a worker pause of');
        for (const cap of [8192, 65536, 262144, 1048576]) {
            console.log(`  ${String(cap).padStart(9)} ${((cap * 16) / 1024).toFixed(0).padStart(7)}KB` +
                `        ${((cap / rate) * 1000).toFixed(1).padStart(8)} ms`);
        }
        console.log('\n  For reference: a minor GC is often 1-10ms and a major GC 10-100ms,');
        console.log('  so 8192 records is roughly one minor GC of headroom.');
    }
})();
