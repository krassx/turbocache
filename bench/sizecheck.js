const l2 = require('../src/native');
// index = 65536 slots x 16B = 1MB, which alone exceeds a 1MB segment
const ok = l2.create('/tc-size-' + process.pid, 1 << 20, 1 << 16, 2);
console.log('create(1MB arena, 65536 slots) returned:', ok);
if (ok) { const s = l2.stats(); console.log('  dataBytes =', s.dataBytes, '  <- nonsense if index did not fit'); l2.destroy(); }
