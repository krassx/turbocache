const { TurboCache } = require('../src/turbocache');
let fail = 0; const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fail++; } };
const c = TurboCache.createPrimary('/tcprim' + process.pid, 32 << 20, 1 << 16,
                                   { values: 'bytes', l1MaxBytes: 1 << 20 });
c.set('s', 'hello'); c.set('n', 42); c.set('b', true);
ok(c.get('s') === 'hello', 'string roundtrip');
ok(c.get('n') === '42' || c.get('n') === 42, 'number roundtrip (stored as text)');
ok(c.get('miss') === undefined, 'miss');
ok(c.set('o', { a: 1 }) === false, 'objects rejected (returns false, never throws)');
ok(c.stats.rejectedType === 1 && /bytes mode/.test(c.lastError), 'rejection is recorded in stats + lastError');
const big = new Array(200000).fill('abcdefgh').join('');
c.set('slice', big.substring(0, 1000));
ok(c.get('slice').length === 1000, 'substring cached and flattened');
TurboCache.native().destroy();
console.log(fail ? `  ${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
