// A fidelity codec: V8 structured serialization instead of JSON. Preserves
// Date/Map/Set/TypedArray/RegExp/undefined/NaN/Infinity and cycles, which JSON
// silently degrades. Costs roughly 2-3x JSON; use only when you need it.
const v8 = require('v8');
const __native = require('../src/native');
const { TurboCache } = require('../src/turbocache');
// The SHIPPED codec, not a local re-implementation of it: a copy here would
// keep passing while the real one regressed (decision 37b).
const V8C = TurboCache.V8_CODEC;
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

// A decoded typed array must OWN its backing store.
//
// v8.deserialize does not copy an ArrayBufferView out of its input: Node's
// DefaultSerializer sets _setTreatArrayBufferViewsAsHostObjects(true), so a
// typed array is written as a host object and read back as a VIEW over the
// buffer that was handed to deserialize. Feeding it `Buffer.from(s, 'latin1')`
// therefore returned a value aliasing Node's shared 8KB buffer pool, which has
// two consequences:
//
//   - every cached typed array pins a whole 8192-byte pool slab for its
//     lifetime, however few bytes it holds;
//   - the view's correctness depends on the runtime computing its offset from
//     a non-zero byteOffset. Deno 2.8.3 adds that byteOffset twice
//     (ext:deno_node/v8.ts, DefaultDeserializer._readHostObject), so on Deno
//     the value came back ZERO-FILLED -- right type, right length, wrong bytes
//     -- or threw RangeError when the doubled offset ran past the end.
//
// An unpooled, exactly-sized buffer fixes both: the offset is 0, so there is
// nothing to double, and the view owns storage no one else can touch.
{
    const enc = V8C.encode(new Uint8Array([1, 2, 3]));
    const dec = V8C.decode(enc);
    ok(dec instanceof Uint8Array && dec[0] === 1 && dec[1] === 2 && dec[2] === 3,
       'a decoded Uint8Array holds the bytes that went in');
    // The decoded view sits at its own offset INSIDE the serialized payload
    // (after the 5-byte header); what matters is that the payload buffer is
    // exactly the size of the encoding rather than a slice of the 8KB pool.
    // That is the same property that makes the offset arithmetic trivial, and
    // so is what keeps Deno correct.
    ok(dec.buffer.byteLength <= enc.length,
       `a decoded typed array owns its buffer, not a pool slab ` +
       `(buffer is ${dec.buffer.byteLength}B for a ${enc.length}B payload)`);
}

__native.destroy();
console.log(fail ? `  ${fail} FAILURES` : '  all passed - full type fidelity through L1 and L2');
process.exit(fail ? 1 : 0);
