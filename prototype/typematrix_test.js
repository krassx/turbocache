// json-fastpath-lint: allow
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
console.log('  input        ' + modes.map(m => m[0].padEnd(24)).join(''));
for (const [label, make] of Object.entries(values)) {
    const row = modes.map(([, opts]) => { const c = mk(opts); const r = probe(c, make); TurboCache.native().destroy(); return r.padEnd(24); });
    console.log('  ' + label.padEnd(12) + ' ' + row.join(''));
}
