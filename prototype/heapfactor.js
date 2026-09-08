// How much V8 heap does a decoded object actually cost, relative to its JSON?
const { makeValue, mkRng } = require('../bench/workload');
function heap() { global.gc(); global.gc(); return process.memoryUsage().heapUsed; }
console.log('  encoded  n objects   heap/object   encoded/object   heapFactor');
for (const bytes of [200, 800, 3200]) {
  const N = 20000;
  const objs = new Array(N);
  const base = heap();
  let enc = 0;
  for (let i = 0; i < N; i++) {
    objs[i] = makeValue(mkRng(i * 2654435761 + bytes), bytes);
    enc += JSON.stringify(objs[i]).length;
  }
  const used = heap() - base;
  if (objs[0] === null) throw 0;                 // keep alive
  console.log(`  ${String(bytes).padStart(7)}  ${String(N).padStart(9)}  ${(used/N).toFixed(0).padStart(11)}B  ${(enc/N).toFixed(0).padStart(14)}B  ${(used/enc).toFixed(2).padStart(11)}x`);
}
