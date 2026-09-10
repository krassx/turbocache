// A fidelity codec: V8 structured serialization instead of JSON. Preserves
// Date/Map/Set/TypedArray/RegExp/undefined/NaN/Infinity and cycles, which JSON
// silently degrades. Costs roughly 2-3x JSON; use only when you need it.
const v8 = require('v8');
const { TurboCache } = require('../src/turbocache');
const V8C = {
    encode: v => v8.serialize(v).toString('latin1'),
    decode: s => v8.deserialize(Buffer.from(s, 'latin1'))
};
let fail = 0; const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fail++; } };

const c = TurboCache.createPrimary('/tcv8' + process.pid, 32 << 20, 1 << 16,
                                   { codec: V8C, l1MaxBytes: 32 * 1024, freeze: false });
const val = { when: new Date('2026-09-08T10:00:00Z'), tags: new Set(['a']), index: new Map([['k', 1]]),
              bytes: new Uint8Array([1, 2, 3]), n: NaN, inf: Infinity, re: /abc/g };
c.set('rich', val);

// force it out of L1 so the value must survive the L2 round trip
for (let i = 0; i < 400; i++) c.set('f' + i, { pad: 'x'.repeat(200) });
const g = c.get('rich');
ok(g !== undefined, 'survives L2 round trip');
ok(g.when instanceof Date && g.when.getTime() === val.when.getTime(), 'Date preserved');
ok(g.tags instanceof Set && g.tags.has('a'), 'Set preserved');
ok(g.index instanceof Map && g.index.get('k') === 1, 'Map preserved');
ok(g.bytes instanceof Uint8Array && g.bytes[2] === 3, 'Uint8Array preserved');
ok(Number.isNaN(g.n), 'NaN preserved');
ok(g.inf === Infinity, 'Infinity preserved');
ok(g.re instanceof RegExp && g.re.source === 'abc', 'RegExp preserved');

let threw = false;
try { TurboCache.assertFastCodec(V8C); } catch { threw = true; }
ok(!threw, 'fast-path check leaves non-JSON codecs alone');

TurboCache.native().destroy();
console.log(fail ? `  ${fail} FAILURES` : '  all passed - full type fidelity through L1 and L2');
process.exit(fail ? 1 : 0);
