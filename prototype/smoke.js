const { TurboCache } = require('./turbocache');
const c = TurboCache.createPrimary('/tc-smoke-' + process.pid, 16 << 20, 1 << 16);
c.set('a', 'hello'); c.set('b', 'world');
console.log('get a =', c.get('a'), '| get b =', c.get('b'), '| miss =', c.get('zz'));
for (let i = 0; i < 20000; i++) c.set('k' + i, 'v'.repeat(200));
let ok = 0; for (let i = 0; i < 20000; i++) if (c.get('k' + i) === 'v'.repeat(200)) ok++;
console.log(`resident ${ok}/20000  stats`, c.stats);
TurboCache.native().destroy();
