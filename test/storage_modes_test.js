'use strict';
const { TurboCache } = require('../src/turbocache');
const __native = require('../src/native');
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
    // A block-level 'use strict' is a no-op expression statement in a sloppy
    // file, so the assignment silently failed and this passed on the second
    // disjunct -- "mutation throws" was never actually tested. A frozen object
    // in strict mode must throw, and the whole file is strict now.
    let threw = false; try { a.when = 1; } catch { threw = true; }
    ok(threw, 'direct: assigning to a frozen cached value throws');
    let mutThrew = false; try { a.when.setTime(0); } catch { mutThrew = true; }
    ok(mutThrew, 'direct: a Date mutator on a frozen value throws (Object.freeze cannot seal it)');
    // Documented hole: typed-array contents cannot be frozen in JS.
    ok(!Object.isFrozen(a.bytes), 'direct: typed arrays are NOT frozen (JS cannot)');
    a.bytes[0] = 99;
    ok(c.get('v').bytes[0] === 99, 'direct: writing into a typed array DOES corrupt L1 - known hole');
    val.tags.add('mutated');
    ok(c.get('v').tags.size === 1, 'direct: caller mutating its own object cannot corrupt the cache');
    __native.destroy();
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
    __native.destroy();
}

// --- both survive an L1 eviction and come back through the shared arena
for (const storage of ['direct', 'safe']) {
    const c = mk(storage);
    c.set('keep', { id: 'x', n: 7 });
    for (let i = 0; i < 400; i++) c.set('p' + i, { pad: 'y'.repeat(300) });
    const g = c.get('keep');
    ok(g && g.n === 7, `${storage}: survives L1 eviction via the arena`);
    __native.destroy();
}

// --- bytes mode rejects anything needing a codec; 'primitives' is a legacy alias
{
    const c = mk('primitives');
    ok(c.storage === 'bytes', "'primitives' is accepted as an alias of 'bytes'");
    ok(c.set('o', { a: 1 }) === false, 'bytes: rejects objects (returns false)');
    ok(c.set('bin', Buffer.from([1,2])) === true, 'bytes: accepts binary, which needs no codec');
    c.set('b', 2n ** 70n);
    ok(c.get('b') === 2n ** 70n, 'bytes: BigInt round-trips');
    __native.destroy();
}
// --- a misconfigured storage/codec must throw where the mistake was made
//
// These two options are one keystroke apart in meaning, and getting them wrong
// used to cost nothing at construction and everything afterwards: the cache was
// built, set() reported success, and every get() returned undefined with nothing
// to say why. Nine of the ten combinations below behaved exactly that way; the
// tenth failed at the first read with "this[#codec].decode is not a function".
{
    const n0 = n;
    // Rendered by hand: a JSON replacer would trip the fast-path lint.
    const label = o => '{ ' + Object.keys(o).map(k => {
        const v = o[k];
        if (v && typeof v === 'object') return `${k}: {${Object.keys(v).join(',')}}`;
        return `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`;
    }).join(', ') + ' }';
    const throws = (opts, mustMention) => {
        let e = null;
        try { TurboCache.createPrimary('/tcsmx' + process.pid + '_' + (n++), 8 << 20, 1 << 13, opts); }
        catch (err) { e = err; }
        ok(e instanceof TypeError, `rejects ${label(opts)} with a TypeError`);
        ok(e != null && mustMention.every(w => e.message.includes(w)),
           `the error for ${label(opts)} names ${mustMention.join(' + ')}` +
           (e ? ` (got: ${e.message.slice(0, 70)})` : ''));
    };

    // the single most natural way to write what the author meant
    throws({ codec: 'direct' }, ['codec', "storage: 'direct'"]);
    throws({ codec: 'safe' },   ['codec', "storage: 'safe'"]);
    // an unknown mode is a misconfiguration, not a mode
    throws({ storage: 'diret' },  ['storage', 'diret']);
    throws({ storage: 'DIRECT' }, ['storage', "Did you mean 'direct'?"]);
    throws({ storage: 42 },       ['storage']);
    // `values` is a documented alias, so it gets the same treatment
    throws({ values: 'diret' },   ['values', 'diret']);
    // The declaration calls codec "mutually exclusive with a storage mode that
    // implies one"; that was never enforced, and the codec was silently dropped.
    throws({ storage: 'bytes', codec: TurboCache.JSON_CODEC }, ['without a codec']);
    throws({ values: 'primitives', codec: TurboCache.JSON_CODEC }, ['without a codec']);
    // a codec that is not one
    throws({ codec: {} },                          ['encode()', 'decode()']);
    throws({ codec: { encode: JSON.stringify } },  ['decode()']);
    throws({ codec: { decode: JSON.parse } },      ['encode()']);
    throws({ codec: 7 },                           ['codec']);

    // ...while everything legitimate still constructs.
    //
    // destroy() between each: create() on an already-created Store neither
    // closes the old mapping nor unlinks its name, so without this the run
    // leaves one arena, one hints segment and one 32MB submission ring behind
    // per iteration -- they outlive the process, and /dev/shm is commonly
    // capped at 64MB in a container.
    let built = 0;
    for (const opts of [{}, { storage: 'bytes' }, { storage: 'direct' }, { storage: 'safe' },
                        { storage: 'primitives' }, { codec: null },
                        { codec: { encode: JSON.stringify, decode: JSON.parse } },
                        { codec: TurboCache.V8_CODEC }]) {
        try {
            TurboCache.createPrimary('/tcsmok' + process.pid + '_' + (n++), 8 << 20, 1 << 13, opts);
            built++;
        } catch (e) { ok(false, `valid options rejected: ${label(opts)} -> ${e.message}`); }
        __native.destroy();
    }
    ok(built === 8, `all 8 valid configurations still construct (got ${built})`);
    ok(n - n0 === 20, 'every configuration above was actually attempted');
    // The rejected ones never reach native.create now, so they leak nothing.

    // `values` was declared "legacy alias for storage" but was not one: only
    // 'bytes'/'primitives' did anything, because they coincide with the
    // internal no-codec flag this option also sets. 'direct' and 'safe'
    // silently selected BYTES mode, so a caller following the declaration had
    // every object rejected by set().
    for (const mode of ['direct', 'safe']) {
        const c = TurboCache.createPrimary('/tcsmal' + process.pid + '_' + (n++), 8 << 20, 1 << 13,
                                           { values: mode, freeze: false });
        ok(c.storage === mode, `values: '${mode}' selects ${mode} mode (got '${c.storage}')`);
        c.set('o', { a: 1 });
        const got = c.get('o');
        ok(got != null && got.a === 1, `values: '${mode}' round-trips an object`);
        __native.destroy();                       // as above: create() does not unlink the old arena
    }
    __native.destroy();
}

console.log(fail ? `  ${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
