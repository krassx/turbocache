const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');
const KEYS = 2000;
const keys = Array.from({length: KEYS}, (_, i) => 'user:session:' + i);
function timeit(fn, N) {
  for (let i = 0; i < 50000; i++) fn(i);
  const t = process.hrtime.bigint(); let s = 0;
  for (let i = 0; i < N; i++) s += fn(i) | 0;
  return Number(process.hrtime.bigint() - t) / N;
}
console.log('LZ4 ON = compress >=256B, LZ4 OFF = never compress\n');
console.log('bytes'.padStart(7), '| getLen on'.padStart(11), 'getLen off'.padStart(11), '| set on'.padStart(9), 'set off'.padStart(9), '| lz4 read'.padStart(10), 'lz4 write'.padStart(10));
for (const len of [256, 1024, 4096, 16384]) {
  const r = {};
  for (const [label, min] of [['on', 256], ['off', 1 << 30]]) {
    l2.create(`/tc-b2-${len}-${label}`, 64 << 20, 1 << 16, 1);
    l2.setCompressMin(min);
    const vals = keys.map(() => makePayload(len));
    keys.forEach((k, i) => l2.set(k, vals[i]));
    const N = len > 8000 ? 2e5 : 1e6;
    r['get' + label] = timeit(i => l2.getLen(keys[i % KEYS]), N);
    r['set' + label] = timeit(i => { l2.set(keys[i % KEYS], vals[i % KEYS]); return 0; }, N / 4);
    l2.destroy();
  }
  console.log(String(len).padStart(7),
    '|', r.geton.toFixed(0).padStart(9), r.getoff.toFixed(0).padStart(10),
    '|', r.seton.toFixed(0).padStart(7), r.setoff.toFixed(0).padStart(8),
    '|', (r.geton - r.getoff).toFixed(0).padStart(8), (r.seton - r.setoff).toFixed(0).padStart(9));
}
