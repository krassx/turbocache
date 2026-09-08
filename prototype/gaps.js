const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');

function mkRng(s0) { let s = s0 >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function mkZipf(N, rnd) {
  const cdf = new Float64Array(N); let sum = 0;
  for (let i = 0; i < N; i++) { sum += 1 / (i + 1); cdf[i] = sum; }
  for (let i = 0; i < N; i++) cdf[i] /= sum;
  return () => { const r = rnd(); let lo = 0, hi = N - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; } return lo; };
}

// ---- GAP 1: workers hold a PROT_READ mapping, so they cannot set CLOCK bits --
console.log('GAP 1: can LOG2 second-chance work when readers cannot set reference bits?\n');
const NKEYS = 40000, OPS = 300000;
const sizeFor = i => [256, 512, 1024, 2048, 4096][((i * 2654435761) >>> 0) % 5];
function hitRate(mode, suppress) {
  l2.create(`/tc-g1-${mode}-${suppress}-${process.pid}`, 24 << 20, 1 << 18, mode);
  l2.setCompressMin(1 << 30);
  l2.suppressRefBit(suppress);
  const rnd = mkRng(777), pick = mkZipf(NKEYS, rnd), src = new Map();
  let h = 0, m = 0;
  for (let n = 0; n < OPS; n++) {
    const i = pick(), k = 'k:' + i;
    if (l2.getLen(k) >= 0) { h++; continue; }
    m++;
    let v = src.get(k); if (v === undefined) { v = makePayload(sizeFor(i)); src.set(k, v); }
    l2.set(k, v);
  }
  const r = h / (h + m); l2.suppressRefBit(false); l2.destroy(); return r;
}
const logPlain   = hitRate(1, false);
const log2Bits   = hitRate(2, false);
const log2NoBits = hitRate(2, true);
console.log(`  LOG  (FIFO, no second chance)              ${(logPlain*100).toFixed(1)}%`);
console.log(`  LOG2, reference bits set (in-process)      ${(log2Bits*100).toFixed(1)}%   <- what every earlier benchmark measured`);
console.log(`  LOG2, reference bits NOT set (real topology) ${(log2NoBits*100).toFixed(1)}%   <- what workers would actually get`);
console.log(`  => second chance is worth ${((log2Bits-logPlain)*100).toFixed(1)} points, and ${((log2Bits-log2NoBits)*100).toFixed(1)} of that is lost\n`);

// ---- GAP 2: open addressing + tombstones, with no rehash or cleanup ---------
console.log('GAP 2: does the index degrade under churn? (tombstones are never reclaimed)\n');
l2.create('/tc-g2-' + process.pid, 64 << 20, 1 << 16, 2);   // 65536 slots
l2.setCompressMin(1 << 30);
const val = makePayload(512);
function missNs(n) {
  for (let i = 0; i < 20000; i++) l2.probe('absent:' + i);
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) l2.probe('absent:' + i);
  return Number(process.hrtime.bigint() - t) / n;
}
function hitNs(n) {
  for (let i = 0; i < 20000; i++) l2.probe('live:' + (i % 1000));
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) l2.probe('live:' + (i % 1000));
  return Number(process.hrtime.bigint() - t) / n;
}
for (let i = 0; i < 1000; i++) l2.set('live:' + i, val);
console.log('  churned inserts      miss probe(ns)   hit probe(ns)   live');
let churn = 0;
for (const target of [0, 50000, 200000, 500000, 1000000]) {
  while (churn < target) { l2.set('churn:' + churn, val); churn++; }
  const s = l2.stats();
  console.log(`  ${String(churn).padStart(15)}   ${missNs(200000).toFixed(0).padStart(12)}   ${hitNs(200000).toFixed(0).padStart(13)}   ${String(s.live).padStart(6)}`);
}
l2.destroy();
