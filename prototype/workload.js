const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');

// Zipfian key generator (s=1.0) over N keys.
function zipf(N) {
  const cdf = new Float64Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) { sum += 1 / (i + 1); cdf[i] = sum; }
  for (let i = 0; i < N; i++) cdf[i] /= sum;
  return () => {
    const r = Math.random();
    let lo = 0, hi = N - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
    return lo;
  };
}

const ARENA = 32 << 20;
const NKEYS = 60000;
const OPS   = 120000;

// value size drawn per key, so a key's size is stable across accesses
function sizeFor(i, phase) {
  const h = (i * 2654435761) >>> 0;
  if (phase === 'small')  return [64, 128, 256][h % 3];
  if (phase === 'large')  return [4096, 8192, 16384][h % 3];
  return [64, 128, 256, 512, 1024, 2048, 4096, 8192][h % 8];   // 'mixed'
}

function run(mode, phases) {
  l2.create(`/tc-wl-${mode}-${Math.random().toString(36).slice(2, 8)}`, ARENA, 1 << 18, mode);
  l2.setCompressMin(1 << 30);           // compression off - see bench2 results
  const pick = zipf(NKEYS);
  const cache = new Map();              // value source, not a cache
  const out = [];
  for (const phase of phases) {
    let hits = 0, misses = 0, setFails = 0; const t0 = Date.now();
    for (let op = 0; op < OPS; op++) {
      const i = pick();
      const k = phase + ':' + i;   // distinct namespace per phase: new keys must find room
      if (l2.getLen(k) >= 0) { hits++; continue; }
      misses++;
      const mk = k;
      let v = cache.get(mk);
      if (v === undefined) { v = makePayload(sizeFor(i, phase)); cache.set(mk, v); }
      if (!l2.set(k, v)) setFails++;
    }
    const s = l2.stats();
    out.push({ phase, hitRate: hits / (hits + misses), setFails, ms: Date.now() - t0,
               live: s.live, util: s.liveBytes / s.dataBytes, evictions: s.evictions });
  }
  l2.destroy();
  return out;
}

const MODES = [[0, 'SLAB'], [1, 'LOG'], [2, 'LOG2']];

function report(title, phases) {
  console.log(`\n${title}`);
  const res = MODES.map(([m]) => run(m, phases));
  let head = '  ' + 'phase'.padEnd(8);
  for (const [, n] of MODES) head += (n + ' hit%').padStart(11);
  for (const [, n] of MODES) head += (n + ' util').padStart(11);
  console.log(head);
  for (let i = 0; i < phases.length; i++) {
    let line = '  ' + phases[i].padEnd(8);
    for (let m = 0; m < MODES.length; m++) line += (res[m][i].hitRate * 100).toFixed(1).padStart(11);
    for (let m = 0; m < MODES.length; m++) line += ((res[m][i].util * 100).toFixed(0) + '%').padStart(11);
    console.log(line);
  }
  const fails = res.map((r, m) => r.reduce((a, x) => a + x.setFails, 0));
  if (fails.some(f => f > 0)) console.log('  setFails: ' + MODES.map(([, n], m) => `${n}=${fails[m]}`).join(' '));
}

console.log(`arena=${ARENA >> 20}MB  keys=${NKEYS}  ops/phase=${OPS}  zipf s=1.0  compression=off`);
report('A. stable mixed sizes (64B-8KB)', ['mixed', 'mixed', 'mixed']);
report('B. phase change: small -> large -> small (slab calcification test)', ['small', 'large', 'small']);
report('C. hard switch: all-small then all-large, repeated', ['small', 'large', 'small', 'large']);
