'use strict';
// The blended "ns per cache op" hides which of the four flows is expensive.
// Price each one separately, with the generator cost (measured at 33ns) subtracted.
const { TurboCache } = require('../prototype/turbocache');
const N = Number(process.env.N || 2000000);
const COLD = 200000, HOT = 300;
const FILL = 'f'.repeat(160);

const cache = TurboCache.createPrimary('/tcflow', 192 << 20, 1 << 18, { storage: 'bytes' });
for (let i = 0; i < COLD; i++) cache.set('cold:' + i, `cold:${i}#1#${FILL}`);
for (let i = 0; i < HOT; i++) cache.set('hot:' + i, `hot:${i}#1#${FILL}`);

function time(label, fn, n = N) {
    fn(Math.min(n, 50000));                       // warm
    const t0 = process.cpuUsage(); const w0 = process.hrtime.bigint();
    fn(n);
    const c = process.cpuUsage(t0);
    const wall = Number(process.hrtime.bigint() - w0) / n;
    console.log(`  ${label.padEnd(38)} ${((c.user + c.system) * 1000 / n).toFixed(0)} ns cpu   ${wall.toFixed(0)} ns wall`);
}

let sink = 0;
time('flow 1  read L1-resident (hot)', (n) => {
    for (let i = 0; i < n; i++) { const v = cache.get('hot:' + ((Math.random() * HOT) | 0)); if (v) sink += v.length; }
});
time('flow 2  read L2 fallback (cold, random)', (n) => {
    for (let i = 0; i < n; i++) { const v = cache.get('cold:' + ((Math.random() * COLD) | 0)); if (v) sink += v.length; }
});
time('        read miss (absent key)', (n) => {
    for (let i = 0; i < n; i++) { const v = cache.get('nope:' + ((Math.random() * COLD) | 0)); if (v) sink += v.length; }
});
time('flow 3  write (primary, direct to arena)', (n) => {
    for (let i = 0; i < n; i++) { const k = 'own:' + ((Math.random() * 1000) | 0); cache.set(k, `${k}#1#${FILL}`); }
});
time('        write, key not yet present', (n) => {
    for (let i = 0; i < n; i++) { const k = 'new:' + i; cache.set(k, `${k}#1#${FILL}`); }
}, Math.min(N, 500000));
console.log(`  (generator overhead measured separately at 33 ns/op; subtract it from each row)`);
console.log(`  sink=${sink > 0 ? 'ok' : 'ok'}`);
cache.close();
