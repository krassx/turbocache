const l2 = require('../src/native');
const { makePayload } = require('./payload');

const KEYS = 2000;
const keys = Array.from({length: KEYS}, (_, i) => 'user:session:' + i);

function timeit(fn, N) {
  for (let i = 0; i < 100000; i++) fn(i);
  const t = process.hrtime.bigint();
  let s = 0;
  for (let i = 0; i < N; i++) s += fn(i) | 0;
  return { ns: Number(process.hrtime.bigint() - t) / N, s };
}

for (const [mode, name] of [[0, 'SLAB'], [1, 'LOG'], [2, 'LOG2']]) {
  console.log(`\n===== ${name} =====`);
  console.log('bytes'.padStart(7), 'probe'.padStart(8), 'getLen'.padStart(8), 'get(full)'.padStart(10),
              'set'.padStart(8), 'jsMapGet'.padStart(9), '   note');
  for (const len of [64, 256, 1024, 4096, 16384]) {
    const arena = Math.max(64 << 20, 1 << (32 - Math.clz32(KEYS * len * 4)));
    l2.create(`/tc-bench-${mode}-${len}`, arena, 1 << 16, mode);
    l2.setCompressMin(1 << 30);   // compression off
    const vals = keys.map(() => makePayload(len));
    keys.forEach((k, i) => l2.set(k, vals[i]));
    const map = new Map(keys.map((k, i) => [k, vals[i]]));

    // sanity: everything must still be resident, or we are benchmarking misses
    const resident = keys.filter((k, i) => l2.get(k) === vals[i]).length;

    const N = len > 8000 ? 3e5 : 2e6;
    const probe  = timeit(i => l2.probe(keys[i % KEYS]), N).ns;
    const getLen = timeit(i => l2.getLen(keys[i % KEYS]), N).ns;
    const get    = timeit(i => { const v = l2.get(keys[i % KEYS]); return v === undefined ? 0 : v.length; }, N).ns;
    const set    = timeit(i => { l2.set(keys[i % KEYS], vals[i % KEYS]); return 0; }, N / 4).ns;
    const mapGet = timeit(i => map.get(keys[i % KEYS]).length, N).ns;

    console.log(String(len).padStart(7), probe.toFixed(0).padStart(8), getLen.toFixed(0).padStart(8),
                get.toFixed(0).padStart(10), set.toFixed(0).padStart(8), mapGet.toFixed(1).padStart(9),
                resident === KEYS ? '' : `   (only ${resident}/${KEYS} resident - MISS-DOMINATED)`);
    l2.destroy();
  }
}
