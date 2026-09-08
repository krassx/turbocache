const { TurboCache } = require('./turbocache');
let fail = 0, n = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fail++; } };
const mk = storage => TurboCache.createPrimary('/tcsm' + process.pid + '_' + (n++), 32 << 20, 1 << 16,
                                               { storage, l1MaxBytes: 1 << 20 });

// --- direct: full fidelity, shared frozen object, mutation throws
{
    const c = mk('direct');
    const val = { when: new Date('2026-09-08T10:00:00Z'), tags: new Set(['a']), m: new Map([['k', 1]]),
                  bytes: new Uint8Array([1, 2]), big: 2n ** 100n };
    c.set('v', val);
    const a = c.get('v'), b = c.get('v');
    ok(a.when instanceof Date, 'direct: Date preserved');
    ok(a.tags instanceof Set && a.m instanceof Map, 'direct: Set/Map preserved');
    ok(a.bytes instanceof Uint8Array && a.big === 2n ** 100n, 'direct: TypedArray/BigInt preserved');
    ok(a === b, 'direct: repeat reads return the SAME object (no per-read work)');
    ok(Object.isFrozen(a), 'direct: result is frozen');
    let threw = false; try { 'use strict'; a.when = 1; } catch { threw = true; }
    ok(threw || a.when instanceof Date, 'direct: mutation cannot corrupt the cache');
    // Documented hole: typed-array contents cannot be frozen in JS.
    ok(!Object.isFrozen(a.bytes), 'direct: typed arrays are NOT frozen (JS cannot)');
    a.bytes[0] = 99;
    ok(c.get('v').bytes[0] === 99, 'direct: writing into a typed array DOES corrupt L1 - known hole');
    val.tags.add('mutated');
    ok(c.get('v').tags.size === 1, 'direct: caller mutating its own object cannot corrupt the cache');
    TurboCache.native().destroy();
}

// --- safe: fresh mutable object per read, JSON conversions apply
{
    const c = mk('safe');
    c.set('v', { when: new Date('2026-09-08T10:00:00Z'), tags: new Set(['a']), n: 1 });
    const a = c.get('v'), b = c.get('v');
    ok(a !== b, 'safe: every read returns a FRESH object');
    ok(!Object.isFrozen(a), 'safe: result is mutable');
    a.n = 999;
    ok(c.get('v').n === 1, 'safe: mutating a result cannot corrupt the cache');
    ok(typeof a.when === 'string', 'safe: Date silently became a string (documented JSON conversion)');
    ok(JSON.stringify(a.tags) === '{}', 'safe: Set silently became {} (documented JSON conversion)');
    TurboCache.native().destroy();
}

// --- both survive an L1 eviction and come back through the shared arena
for (const storage of ['direct', 'safe']) {
    const c = mk(storage);
    c.set('keep', { id: 'x', n: 7 });
    for (let i = 0; i < 400; i++) c.set('p' + i, { pad: 'y'.repeat(300) });
    const g = c.get('keep');
    ok(g && g.n === 7, `${storage}: survives L1 eviction via the arena`);
    TurboCache.native().destroy();
}

// --- primitives still rejects non-primitives loudly
{
    const c = mk('primitives');
    ok(c.set('o', { a: 1 }) === false, 'primitives: rejects objects (returns false)');
    c.set('b', 2n ** 70n);
    ok(c.get('b') === 2n ** 70n, 'primitives: BigInt round-trips');
    TurboCache.native().destroy();
}
console.log(fail ? `  ${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
