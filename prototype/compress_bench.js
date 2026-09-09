// At a FIXED memory budget, what does compression actually buy?
const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');

const NKEYS = 40000, OPS = 300000;
const ARENA = (Number(process.env.ARENA_MB) || 24) << 20;
const _native = require('./build/Release/l2.node');
if (!_native.hasLz4()) {
    console.log('  SKIPPED: this addon was built without LZ4 ' +
                '(rebuild with --turbocache_lz4=1 to run the compression measurements)');
    process.exit(0);
}

function mkRng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function mkZipf(N, rnd) {
  const cdf = new Float64Array(N); let sum = 0;
  for (let i = 0; i < N; i++) { sum += 1 / (i + 1); cdf[i] = sum; }
  for (let i = 0; i < N; i++) cdf[i] /= sum;
  return () => { const r = rnd(); let lo = 0, hi = N - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; } return lo; };
}
const SIZES = JSON.parse(process.env.SIZES || '[256,512,1024,2048,4096]');
const sizeFor = i => SIZES[((i * 2654435761) >>> 0) % SIZES.length];

function run(compressMin, accel) {
  l2.create(`/tc-cz-${compressMin}-${process.pid}`, ARENA, 1 << 18, 2);
  l2.setCompressMin(compressMin, accel || 1);
  const rnd = mkRng(20260908), pick = mkZipf(NKEYS, rnd);
  const src = new Map();
  let hits = 0, misses = 0;
  const t0 = Date.now();
  for (let n = 0; n < OPS; n++) {
    const i = pick(), k = 'k:' + i;
    if (l2.getLen(k) >= 0) { hits++; continue; }
    misses++;
    let v = src.get(k);
    if (v === undefined) { v = makePayload(sizeFor(i)); src.set(k, v); }
    l2.set(k, v);
  }
  const wall = Date.now() - t0, s = l2.stats();
  const res = [];
  for (let i = 0; i < NKEYS && res.length < 2000; i++) if (l2.getLen('k:' + i) >= 0) res.push('k:' + i);
  for (let n = 0; n < 200000; n++) l2.get(res[n % res.length]);
  let t = process.hrtime.bigint();
  for (let n = 0; n < 500000; n++) l2.get(res[n % res.length]);
  const getNs = Number(process.hrtime.bigint() - t) / 500000;
  const setVals = res.map(k => src.get(k));
  t = process.hrtime.bigint();
  for (let n = 0; n < 200000; n++) l2.set(res[n % res.length], setVals[n % res.length]);
  const setNs = Number(process.hrtime.bigint() - t) / 200000;
  l2.destroy();
  return { dataMB: s.dataBytes / 1048576, hitRate: hits / (hits + misses), live: s.live, getNs, setNs, wall };
}

console.log(`fixed budget, sizes=${SIZES.join('/')}B, keys=${NKEYS}, zipf s=1.0\n`);
console.log('  policy                   data   hit%     live   get(ns)  set(ns)');
const cases = JSON.parse(process.env.CASES || '[["off",1073741824,1],["compress >=1KB",1024,1]]');
for (const [label, min, accel] of cases) {
  const r = run(min, accel);
  console.log(`  ${label.padEnd(23)} ${r.dataMB}MB  ${(r.hitRate*100).toFixed(1).padStart(5)}  ${String(r.live).padStart(7)}  ${r.getNs.toFixed(0).padStart(7)}  ${r.setNs.toFixed(0).padStart(7)}`);
}
