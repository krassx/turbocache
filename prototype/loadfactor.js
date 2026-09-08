const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');
const SLOTS = 1 << 16;                       // 65536 index slots
const val = makePayload(128);
l2.create('/tc-lf-' + process.pid, 256 << 20, SLOTS, 2);   // data region far larger than the index needs
l2.setCompressMin(1 << 30);
function probeNs(prefix, n) {
  for (let i = 0; i < 20000; i++) l2.probe(prefix + i);
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) l2.probe(prefix + i);
  return Number(process.hrtime.bigint() - t) / n;
}
console.log(`index slots=${SLOTS}, no tombstones (fresh inserts only)\n`);
console.log('  live    load%   hit probe(ns)  miss probe(ns)');
let i = 0;
for (const lf of [0.25, 0.5, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  const target = Math.floor(SLOTS * lf);
  while (i < target) { l2.set('key:' + i, val); i++; }
  const s = l2.stats();
  const N = 100000;
  console.log(`  ${String(s.live).padStart(6)}  ${(100*s.live/SLOTS).toFixed(0).padStart(5)}%  ${probeNs('key:', N).toFixed(0).padStart(13)}  ${probeNs('absent:', N).toFixed(0).padStart(14)}`);
  if (s.live < target * 0.9) { console.log('  (inserts failing - index saturated)'); break; }
}
l2.destroy();
