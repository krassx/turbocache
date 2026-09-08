const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');
const SLOTS = 1 << 16;
const val = makePayload(2048);
// Small data region => constant eviction => constant tombstone creation,
// while the number of LIVE entries stays tiny. Isolates tombstones from load factor.
l2.create('/tc-tomb-' + process.pid, 8 << 20, SLOTS, 2);
l2.setCompressMin(1 << 30);
function probeNs(prefix, n) {
  for (let i = 0; i < 10000; i++) l2.probe(prefix + i);
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) l2.probe(prefix + i);
  return Number(process.hrtime.bigint() - t) / n;
}
console.log(`index slots=${SLOTS}, 4MB data region (evicts constantly), value=2KB\n`);
console.log('  inserts    live   load%   hit probe(ns)  miss probe(ns)');
let i = 0;
for (const target of [1000, 20000, 60000, 65536, 80000, 150000, 400000]) {
  while (i < target) { l2.set('k:' + i, val); i++; }
  const s = l2.stats();
  console.log(`  ${String(i).padStart(7)}  ${String(s.live).padStart(6)}  ${(100*s.live/SLOTS).toFixed(0).padStart(5)}%  ${probeNs('k:' + (i - 500) + '_', 50000).toFixed(0).padStart(13)}  ${probeNs('absent:', 50000).toFixed(0).padStart(14)}`);
}
l2.destroy();
