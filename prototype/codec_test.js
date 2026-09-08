const { TurboCache } = require('./turbocache');
const JSONC = { encode: JSON.stringify, decode: JSON.parse };
let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fail++; } };

const cache = TurboCache.createPrimary('/tc-codec-' + process.pid, 32 << 20, 1 << 16,
                                       { codec: JSONC, l1MaxBytes: 256 * 1024 });
const obj = { id: 'x1', items: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }], nested: { deep: true } };
cache.set('o1', obj);
ok(cache.get('o1') === obj, 'L1 hit returns the identical object (no decode, no copy)');

const filler = { pad: 'x'.repeat(2000) };
for (let i = 0; i < 500; i++) cache.set('f' + i, filler);   // evict o1 from L1
const g2 = cache.get('o1');
ok(g2 !== undefined, 'still resident in L2 after L1 eviction');
ok(g2 !== obj, 'L2 path returns a freshly decoded object, not the original reference');
ok(JSON.stringify(g2) === JSON.stringify(obj), 'L2-decoded value matches');
ok(cache.get('nope') === undefined, 'miss returns undefined');
TurboCache.native().destroy();

const cf = TurboCache.createPrimary('/tc-codec2-' + process.pid, 8 << 20, 1 << 16,
                                    { codec: JSONC, freeze: true });
cf.set('fz', { a: { b: 1 } });
const fz = cf.get('fz');
ok(Object.isFrozen(fz) && Object.isFrozen(fz.a), 'freeze:true deep-freezes cached objects');
TurboCache.native().destroy();

console.log(fail ? `${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
