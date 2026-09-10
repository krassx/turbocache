'use strict';
// flow 2 (cold read, L2 fallback) priced at 2916ns vs 265-497ns for a bare L2
// lookup. The difference must be the L1 refill on every hit: 200k cold keys
// against a small L1 means each read inserts a value that is evicted before it
// is ever reused. Vary L1 to see whether that is the whole story.
const { TurboCache } = require('../src/turbocache');
const COLD = 200000, N = 300000;
const FILL = 'f'.repeat(160);
for (const l1mb of [2, 8, 32, 128]) {
    const cache = TurboCache.createPrimary('/tcf2_' + l1mb, 192 << 20, 1 << 18,
        { storage: 'bytes', l1MaxBytes: l1mb << 20 });
    for (let i = 0; i < COLD; i++) cache.set('cold:' + i, `cold:${i}#1#${FILL}`);
    let sink = 0;
    for (let i = 0; i < 20000; i++) { const v = cache.get('cold:' + ((Math.random() * COLD) | 0)); if (v) sink += v.length; }
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) { const v = cache.get('cold:' + ((Math.random() * COLD) | 0)); if (v) sink += v.length; }
    const ns = Number(process.hrtime.bigint() - t0) / N;
    const s = cache.stats;
    console.log(`  L1=${String(l1mb).padStart(3)}MB   ${ns.toFixed(0).padStart(5)} ns/read` +
                `   l1Hits=${s.l1Hits ?? '?'} l1Evictions=${s.l1Evictions ?? '?'}`);
    cache.close();
}
