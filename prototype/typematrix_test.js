// json-fastpath-lint: allow
//
// This printed a matrix and exited 0 regardless of what it showed, so any
// silent change in type behaviour -- a mode starting to reject a type it used to
// accept, or JSON degrading something new -- passed unnoticed. The matrix is the
// point of the file, so the expectations below ARE the matrix: each cell states
// what that mode is supposed to do, including the lossy JSON cells, which are
// correct behaviour rather than bugs (decision 29).
const v8 = require('v8');
const { TurboCache } = require('./turbocache');
const JSONC = { encode: JSON.stringify, decode: JSON.parse };
const V8C = { encode: v => v8.serialize(v).toString('latin1'),
              decode: s => v8.deserialize(Buffer.from(s, 'latin1')) };
let n = 0;
const mk = o => TurboCache.createPrimary('/tctm' + process.pid + '_' + (n++), 32 << 20, 1 << 16,
                                         { l1MaxBytes: 16 * 1024, freeze: false, ...o });

const values = {
    'string':    () => 'hi',
    'number':    () => 42,
    'boolean':   () => true,
    'null':      () => null,
    'BigInt':    () => 123456789012345678901234567890n,
    'Date':      () => new Date('2026-09-08T10:00:00Z'),
    'Array':     () => [1, 'a', { b: 2 }],
    'Object':    () => ({ a: 1, b: [2] }),
    'Map':       () => new Map([['k', 1]]),
    'Set':       () => new Set([1, 2]),
    'Uint8Array':() => new Uint8Array([1, 2, 3])
};

function describe(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const c = v.constructor && v.constructor.name;
    if (typeof v === 'bigint') return 'BigInt(' + v + ')';
    if (v instanceof Date) return 'Date';
    if (v instanceof Map) return 'Map(' + v.size + ')';
    if (v instanceof Set) return 'Set(' + v.size + ')';
    if (v instanceof Uint8Array) return 'Uint8Array';
    if (Array.isArray(v)) return 'Array(' + v.length + ')';
    if (typeof v === 'object') return 'Object{' + Object.keys(v).join(',') + '}';
    return typeof v + '(' + String(v) + ')';
}

function probe(cache, make) {
    let orig;
    try { orig = make(); if (cache.set('t', orig) === false) return 'rejected'; }
    catch (e) { return 'set THROWS ' + e.constructor.name; }
    // force through L2 so we test the real round trip, not just L1
    for (let i = 0; i < 250; i++) cache.set('p' + i, 'x'.repeat(200));
    let got;
    try { got = cache.get('t'); } catch (e) { return 'get THROWS ' + e.constructor.name; }
    if (got === undefined) return 'LOST';
    return describe(got);
}

const modes = [['bytes', { values: 'bytes' }], ['codec: JSON', { codec: JSONC }], ['codec: v8', { codec: V8C }]];
// rows: input type -> [bytes, JSON, v8]
const EXPECT = {
    'string':     ['string(hi)', 'string(hi)', 'string(hi)'],
    'number':     ['number(42)', 'number(42)', 'number(42)'],
    'boolean':    ['boolean(true)', 'boolean(true)', 'boolean(true)'],
    'null':       ['null', 'null', 'null'],
    'BigInt':     ['BigInt(123456789012345678901234567890)', 'rejected', 'BigInt(123456789012345678901234567890)'],
    'Date':       ['rejected', 'string(2026-09-08T10:00:00.000Z)', 'Date'],
    'Array':      ['rejected', 'Array(3)', 'Array(3)'],
    'Object':     ['rejected', 'Object{a,b}', 'Object{a,b}'],
    'Map':        ['rejected', 'Object{}', 'Map(1)'],
    'Set':        ['rejected', 'Object{}', 'Set(2)'],
    'Uint8Array': ['Uint8Array', 'Object{0,1,2}', 'Uint8Array'],
};
let fails = 0;
console.log('  input        ' + modes.map(m => m[0].padEnd(24)).join(''));
for (const [label, make] of Object.entries(values)) {
    // close(), not native().destroy(). Reaching past the instance to destroy the
    // arena leaves the cache registered in `instances` and the module's
    // storeReady flag set, so every cell of this matrix accumulated another live
    // instance that later invalidations still walked. close() releases the ring
    // slot, stops the guard, and deregisters.
    const raw = modes.map(([, opts]) => { const c = mk(opts); const r = probe(c, make); c.close(); return r; });
    console.log('  ' + label.padEnd(12) + ' ' + raw.map(r => r.padEnd(24)).join(''));
    const want = EXPECT[label];
    if (!want) { console.log(`  FAIL: no expectation recorded for ${label}`); fails++; continue; }
    raw.forEach((got, i) => {
        if (got !== want[i]) {
            console.log(`  FAIL: ${label} / ${modes[i][0]}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want[i])}`);
            fails++;
        }
    });
}
console.log(fails ? `\n  ${fails} FAILED` : '\n  all cells match the documented type matrix');
process.exit(fails ? 1 : 0);
