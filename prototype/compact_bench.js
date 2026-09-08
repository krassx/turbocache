const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');

const ARENA = (Number(process.env.ARENA_MB) || 24) << 20;
const NKEYS = 40000;
const OPS   = 300000;
const BATCH = 5000;

// deterministic RNG so both runs see the identical workload
function mkRng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function mkZipf(N, rnd) {
  const cdf = new Float64Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) { sum += 1 / (i + 1); cdf[i] = sum; }
  for (let i = 0; i < N; i++) cdf[i] /= sum;
  return () => { const r = rnd(); let lo = 0, hi = N - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; } return lo; };
}
const SIZES = JSON.parse(process.env.SIZES || '[256,512,1024,2048,4096]');
const sizeFor = i => SIZES[((i * 2654435761) >>> 0) % SIZES.length];
const COLD = process.env.COLD === '1';
const compact = (n, min) => new Promise(res => l2.compactAsync(n, min, 0, COLD, res));

async function run(withCompaction) {
  l2.create(`/tc-cb-${withCompaction ? 'c' : 'p'}-${process.pid}`, ARENA, 1 << 18, 2);
  l2.setCompressMin(1 << 30);                 // foreground writes never compress
  const rnd = mkRng(20260906), pick = mkZipf(NKEYS, rnd);
  const src = new Map();
  let hits = 0, misses = 0;
  const t0 = Date.now();
  for (let done = 0; done < OPS; done += BATCH) {
    for (let n = 0; n < BATCH; n++) {
      const i = pick(), k = 'k:' + i;
      if (l2.getLen(k) >= 0) { hits++; continue; }
      misses++;
      let v = src.get(k);
      if (v === undefined) { v = makePayload(sizeFor(i)); src.set(k, v); }
      l2.set(k, v);
    }
    if (withCompaction) await compact(1200, 256);
  }
  const ms = Date.now() - t0, s = l2.stats(), cs = l2.compactStats();
  // read latency on keys that are actually resident, post-compaction
  const resident = [];
  for (let i = 0; i < NKEYS && resident.length < 2000; i++) if (l2.getLen('k:' + i) >= 0) resident.push('k:' + i);
  let getNs = 0;
  if (resident.length) {
    for (let n = 0; n < 200000; n++) l2.get(resident[n % resident.length]);
    const t = process.hrtime.bigint();
    for (let n = 0; n < 500000; n++) l2.get(resident[n % resident.length]);
    getNs = Number(process.hrtime.bigint() - t) / 500000;
  }
  l2.destroy();
  return { dataMB: s.dataBytes/1048576, getNs, hitRate: hits / (hits + misses), ms, live: s.live,
           util: s.liveBytes / s.dataBytes, applied: cs.applied, stale: cs.stale,
           reclaimed: cs.reclaimed };
}

(async () => {
  console.log(`arena=${ARENA>>20}MB keys=${NKEYS} ops=${OPS} zipf s=1.0 sizes=256B-4KB\n`);
  const plain = await run(false);
  const comp  = process.env.SKIP_COMPACT ? null : await run(true);
  console.log(`sizes=${SIZES.join('/')}B`);
  console.log('                        hit%     live   util   get(ns)  wall(ms)');
  const row = (n, r) => console.log(`  ${(n + ' [' + r.dataMB + 'MB data]').padEnd(28)} ${(r.hitRate*100).toFixed(1).padStart(5)}  ${String(r.live).padStart(7)}  ${(r.util*100).toFixed(0).padStart(4)}%  ${r.getNs.toFixed(0).padStart(7)}  ${String(r.ms).padStart(8)}`);
  row('LOG2 plain', plain); if (comp) row('LOG2 + bg compaction', comp);
  if (comp) {
    console.log(`\n  compaction: applied=${comp.applied} stale=${comp.stale} reclaimed=${(comp.reclaimed/1048576).toFixed(1)}MB`);
    const d = (comp.hitRate - plain.hitRate) * 100;
    console.log(`  delta: ${d >= 0 ? '+' : ''}${d.toFixed(1)} points hit rate, ${((comp.live/plain.live - 1)*100).toFixed(0)}% more entries resident`);
  }
})();
