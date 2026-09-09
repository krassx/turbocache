// json-fastpath-lint: allow - the counting codec wraps JSON deliberately.
// Where does JSON actually get called? Count it, do not assume.
const { TurboCache } = require('./turbocache');
let enc = 0, dec = 0;
const COUNTING = { encode: v => { enc++; return JSON.stringify(v); },
                   decode: s => { dec++; return JSON.parse(s); } };

function run(label, opts, ops) {
    enc = dec = 0;
    const c = TurboCache.createPrimary('/tcjc' + process.pid + label.length, 64 << 20, 1 << 18, opts);
    const val = i => ({ id: 'u' + i, items: [1, 2, 3], s: 'x'.repeat(200) });
    const SETS = 500;
    for (let i = 0; i < SETS; i++) c.set('k' + i, opts.codec ? val(i) : JSON.stringify(val(i)));
    const encAfterSets = enc, decAfterSets = dec;
    for (let n = 0; n < ops; n++) c.get('k' + (n % SETS));
    console.log(`  ${label}`);
    console.log(`    ${SETS} sets + ${ops} gets  ->  L1 hits ${c.stats.l1Hits}, L2 hits ${c.stats.l2Hits}`);
    console.log(`    stringify: ${encAfterSets} during sets, ${enc - encAfterSets} during gets`);
    console.log(`    parse    : ${decAfterSets} during sets, ${dec - decAfterSets} during gets` +
                `  (${((dec - decAfterSets) / ops).toFixed(3)} per get)\n`);
    TurboCache.native().destroy();
}

run('codec mode, working set fits in L1', { codec: COUNTING, l1MaxBytes: 4 << 20 }, 5000);
run('codec mode, tiny L1 (forces L2 reads)', { codec: COUNTING, l1MaxBytes: 24 * 1024 }, 5000);
run('bytes mode (cache never sees JSON)', { values: 'bytes', l1MaxBytes: 4 << 20 }, 5000);
