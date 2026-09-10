const native = require('../src/native');
function heap() { global.gc(); global.gc(); global.gc(); return process.memoryUsage().heapUsed; }
const MB = 2 ** 20;
function heapString(len) { return new Array(Math.ceil(len/8)).fill('abcdefgh').join('').slice(0, len); }
globalThis.KEEP = null;

function trial(label, make) {
    const SLICE = globalThis.SLICE;
    const b0 = heap();
    let parent = heapString(8 * MB);
    globalThis.KEEP = make(parent.substring(0, SLICE));
    parent = null;
    const d = heap() - b0;
    const probe = globalThis.KEEP.charCodeAt(10);
    console.log(`  ${label.padEnd(28)} ${(d/MB).toFixed(2).padStart(6)}MB retained (probe ${probe})`);
    globalThis.KEEP = null;
}
for (const SLICE of [1000, 64 * 1024]) {
  globalThis.SLICE = SLICE;
  console.log(`  ${SLICE}-char substring of an 8MB parent:`);
  trial('kept as-is', s => s);
  trial('native.flatten()', s => native.flatten(s));
  console.log('');
}

const s1 = heapString(4 * MB).substring(0, 200);
const bench = (n, f) => { for (let i=0;i<20000;i++) f(); const t=process.hrtime.bigint();
    for (let i=0;i<200000;i++) f(); console.log('  '+n.padEnd(28)+(Number(process.hrtime.bigint()-t)/200000).toFixed(0).padStart(6)+'ns'); };
console.log('\n  cost of flattening (200-char value):');
bench('native.flatten', () => native.flatten(s1));
bench('(baseline: hashKey)', () => native.hashKey('sess:12345'));
