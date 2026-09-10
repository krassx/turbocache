'use strict';
// The load test charges ALL worker CPU to "per cache op", but the generator does
// real work per iteration too: RNG, key string construction, value building and
// verification. Run the identical loop against a no-op cache to price that, so
// the cache's own share is a subtraction rather than an assumption.
const { TurboCache } = require('../src/turbocache');
const N = Number(process.env.N || 3000000);
const COLD = 200000, HOT = 300, SHARED = 500;
const FILL = 'f'.repeat(160);

function run(cache, label) {
    // identical body to the worker loop in load.js
    let sink = 0;
    const t0 = process.cpuUsage();
    for (let i = 0; i < N; i++) {
        const r = Math.random();
        if (r < 0.40) {
            const v = cache.get('hot:' + ((Math.random() * HOT) | 0));
            if (v) sink += v.length;
        } else if (r < 0.65) {
            const v = cache.get('cold:' + ((Math.random() * COLD) | 0));
            if (v) sink += v.length;
        } else if (r < 0.80) {
            const k = 'own:1:' + ((Math.random() * 1000) | 0);
            cache.set(k, `${k}#1#${FILL}`);
        } else if (r < 0.90) {
            const k = 'shared:' + ((Math.random() * SHARED) | 0);
            cache.set(k, `${k}#1#${FILL}`);
        } else {
            const k = 'shared:' + ((Math.random() * SHARED) | 0);
            const v = cache.get(k);
            if (v && !v.startsWith(k)) sink++;
        }
    }
    const c = process.cpuUsage(t0);
    const ns = (c.user + c.system) * 1000 / N;
    console.log(`  ${label.padEnd(34)} ${ns.toFixed(0)} ns/op   (sink=${sink > 0 ? 'ok' : 'ok'})`);
    return ns;
}

const noop = { get: () => undefined, set: () => {}, flush: () => {} };
const gen = run(noop, 'generator only (no-op cache)');

const cache = TurboCache.createPrimary('/tccal', 192 << 20, 1 << 18, { storage: 'bytes' });
for (let i = 0; i < COLD; i++) cache.set('cold:' + i, `cold:${i}#1#${FILL}`);
for (let i = 0; i < HOT; i++) cache.set('hot:' + i, `hot:${i}#1#${FILL}`);
const full = run(cache, 'generator + turbocache');
console.log(`\n  turbocache's own share             ${(full - gen).toFixed(0)} ns/op` +
            `   (${(100 * (full - gen) / full).toFixed(0)}% of the loop; the generator is the other ${(100 * gen / full).toFixed(0)}%)`);
cache.close();
