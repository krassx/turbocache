// Ground truth: real V8 heap cost per object, vs three ways of estimating it.
const native = require('./build/Release/l2.node');
const { makeValue, mkRng } = require('../bench/workload');
const v8 = require('v8');

function heap() { global.gc(); global.gc(); global.gc(); return process.memoryUsage().heapUsed; }

console.log('  Ground truth = measured heapUsed delta / object, after forced GC.\n');
console.log('  shape        truth   encoded  enc x3   err    native est   err     v8.serialize  err');
for (const [label, bytes] of [['small', 200], ['medium', 800], ['large', 3200]]) {
    const N = 20000;
    const objs = new Array(N);
    const base = heap();
    for (let i = 0; i < N; i++) objs[i] = makeValue(mkRng(i * 2654435761 + bytes), bytes);
    const truth = (heap() - base) / N;
    if (objs[0] === null) throw 0;

    const enc = objs.reduce((a, o) => a + JSON.stringify(o).length, 0) / N;
    const est = objs.reduce((a, o) => a + native.estimateSize(o), 0) / N;
    const ser = objs.reduce((a, o) => a + v8.serialize(o).length, 0) / N;
    const err = x => (((x - truth) / truth) * 100).toFixed(0).padStart(4) + '%';
    console.log(`  ${label.padEnd(8)} ${truth.toFixed(0).padStart(7)}B ${enc.toFixed(0).padStart(9)}B` +
        ` ${(enc * 3).toFixed(0).padStart(7)}B ${err(enc * 3)}  ${est.toFixed(0).padStart(9)}B ${err(est)}` +
        `  ${ser.toFixed(0).padStart(11)}B ${err(ser)}`);
}

// cost per call
const o = makeValue(mkRng(1), 800);
const bench = (name, fn) => {
    for (let i = 0; i < 20000; i++) fn(o);
    const t = process.hrtime.bigint();
    for (let i = 0; i < 100000; i++) fn(o);
    console.log('  ' + name.padEnd(26) + (Number(process.hrtime.bigint() - t) / 100000).toFixed(0).padStart(7) + 'ns');
};
console.log('\n  cost per call (800B object):');
bench('JSON.stringify (needed anyway)', x => JSON.stringify(x));
bench('native.estimateSize', x => native.estimateSize(x));
bench('v8.serialize', x => v8.serialize(x));
bench('v8.getHeapStatistics', () => v8.getHeapStatistics());
