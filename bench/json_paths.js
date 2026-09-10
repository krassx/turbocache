'use strict';
// json-fastpath-lint: allow - this benchmark measures the slow paths on purpose.
// Which string representations hit V8's fast JSON.parse path, and does our
// cache hand back one of them?
const native = require('../src/native');

function mkObj(n, nonAscii) {
    const items = [];
    for (let i = 0; i < n; i++) items.push({ k: (nonAscii ? 'ключ' : 'key') + i, v: i, s: (nonAscii ? 'значение' : 'value') + i });
    return { id: 'doc', ts: 1757000000000, items };
}
const OBJ = mkObj(40, false);
const OBJ_U = mkObj(40, true);
const JSON_ASCII = JSON.stringify(OBJ);
const JSON_UNI = JSON.stringify(OBJ_U);

native.create('/tcjson' + process.pid, 64 << 20, 1 << 16, 2);
native.setCompressMin(1 << 30);
native.set('doc', JSON_ASCII, 0);

// Build each representation deliberately.
const reps = {
    'flat one-byte (Buffer)':  Buffer.from(JSON_ASCII, 'latin1').toString('latin1'),
    'flat, from our cache':    native.get('doc'),
    'flat via native.flatten': native.flatten(JSON_ASCII),
    'sliced (substring)':      (' '.repeat(64) + JSON_ASCII).substring(64),
    'cons (a + b)':            JSON_ASCII.slice(0, 10) + JSON_ASCII.slice(10),
    'two-byte (non-ASCII)':    JSON_UNI
};

function bench(fn, iters) {
    for (let i = 0; i < 2000; i++) fn();
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    return Number(process.hrtime.bigint() - t) / iters;
}

console.log(`node ${process.version}   payload ${JSON_ASCII.length}B ascii / ${JSON_UNI.length}B unicode\n`);
console.log('  JSON.parse by string representation');
const base = bench(() => JSON.parse(reps['flat one-byte (Buffer)']), 50000);
for (const [name, s] of Object.entries(reps)) {
    const ns = bench(() => JSON.parse(s), 50000);
    console.log(`    ${name.padEnd(26)} ${ns.toFixed(0).padStart(7)}ns   ${(ns / base).toFixed(2)}x vs flat one-byte   (${s.length}B)`);
}

console.log('\n  JSON.stringify variants');
const sBase = bench(() => JSON.stringify(OBJ), 50000);
const variants = {
    'plain object':        () => JSON.stringify(OBJ),
    'with 2-space indent': () => JSON.stringify(OBJ, null, 2),
    'with replacer fn':    () => JSON.stringify(OBJ, (k, v) => v),
    'with key allowlist':  () => JSON.stringify(OBJ, ['id', 'ts']),
    'object w/ non-ASCII': () => JSON.stringify(OBJ_U)
};
for (const [name, fn] of Object.entries(variants)) {
    const ns = bench(fn, 50000);
    console.log(`    ${name.padEnd(26)} ${ns.toFixed(0).padStart(7)}ns   ${(ns / sBase).toFixed(2)}x vs plain`);
}
native.destroy();
