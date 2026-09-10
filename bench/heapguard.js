// Does a post-GC guard bound LIVE heap when the byte estimate is wrong?
const { TurboCache } = require('../src/turbocache');
const { makeValue, mkRng } = require('../bench/workload');
const v8 = require('v8');
const { PerformanceObserver } = require('perf_hooks');
const JSONC = { encode: JSON.stringify, decode: JSON.parse };
const lim = v8.getHeapStatistics().heap_size_limit;

// independent observer: record live heap after every GC
let peakLive = 0;
new PerformanceObserver(() => {
    peakLive = Math.max(peakLive, v8.getHeapStatistics().used_heap_size);
}).observe({ entryTypes: ['gc'] });

let seq = 0;
async function fill(opts, label) {
    peakLive = 0;
    const c = TurboCache.createPrimary('/tchg' + process.pid + '_' + (seq++), 64 << 20, 1 << 16,
        { codec: JSONC, l1MaxBytes: 1 << 30, ...opts });   // budget deliberately absurd
    for (let i = 0; i < 200000; i++) {
        c.set('k' + i, makeValue(mkRng(i), 800));
        // A server turns the event loop constantly; GC notifications are
        // delivered on a later tick, so a fully synchronous loop never sees them.
        if ((i & 255) === 255) await new Promise(setImmediate);
    }
    await new Promise(r => setTimeout(r, 50));
    // Ground truth: what the cache still RETAINS once garbage is collected.
    global.gc(); global.gc(); global.gc();
    const retained = process.memoryUsage().heapUsed;
    console.log(`  ${label.padEnd(20)} retained live heap ${(retained / 2 ** 20).toFixed(0).padStart(4)}MB` +
        ` (${(100 * retained / lim).toFixed(0).padStart(3)}% of limit)   shed: ${String(c.stats.heapShed || 0).padStart(2)}` +
        `   L1 entries: ${String(c.l1Size).padStart(6)}`);
    c.stopGuard();
    TurboCache.native().destroy();
}
console.log(`  heap limit ${(lim / 2 ** 20).toFixed(0)}MB; L1 byte budget 1GB (deliberately wrong)\n`);
(async () => {
    await fill({ heapGuard: false }, 'guard off');
    await fill({ heapGuard: { maxHeapFraction: 0.20 } }, 'guard at 20% live');
    await fill({ heapGuard: { maxHeapFraction: 0.40 } }, 'guard at 40% live');
})();
