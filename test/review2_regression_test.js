// Regressions for the second adversarial review (three agents: never-reviewed
// code, native races/memory, API/packaging/tests).
//
// Every case here drives the PUBLIC path in the configuration that actually
// ships, because the recurring failure in this repo has been tests that
// exercise a helper or a non-default mode and so keep passing while the shipped
// path regresses.
const { TurboCache } = require('../src/turbocache');
const native = require('../src/native');
let fails = 0, n = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fails++; };
const mk = (o) => TurboCache.createPrimary('/tcr2_' + process.pid + '_' + (n++), 16 << 20, 1 << 14,
    { storage: 'bytes', l1MaxBytes: 1 << 18, ...o });

// incr/cas write a natively-typed number, bypassing the codec. get() then fed
// that number to codec.decode and the key became permanently unreadable:
// `direct` threw TypeError on every read, `safe` threw SyntaxError once the
// value was NaN. Refused now, rather than producing a key that throws.
for (const mode of ['direct', 'safe']) {
    const c = mk({ storage: mode });
    ok(c.incr('fresh', 5) === false, `${mode}: incr is refused rather than writing an unreadable entry`);
    ok(/storage/.test(c.lastError || ''), `${mode}: incr says why`);
    ok(c.cas('fresh', 1, 2) === false, `${mode}: cas is refused too`);
    let threw = false;
    try { c.clearLocal(); c.get('fresh'); } catch { threw = true; }
    ok(!threw, `${mode}: the key stays readable after a refused incr`);
    c.close();
}
{
    const c = mk({});
    ok(c.incr('n', 2) === 2, 'bytes: incr still works');
    ok(c.cas('n', 2, 7) === true, 'bytes: cas still works');
    c.close();
}

// A degraded handle must be observable. `lastError` was the only signal and the
// next write overwrote it with "submission ring full", blaming backpressure for
// a dead primary.
{
    const c = mk({});
    ok(c.primaryDead === false, 'primaryDead is exposed and false while healthy');
    c.close();
}

// SweepExpired was the one expiry comparison left non-wrap-aware; it deleted
// live entries whose expiry crossed the uint32 wrap. Covered natively in
// native_regression_test.cc; here we only pin that a normal TTL still survives
// a sweep, which is the property that fix must not break.
{
    const c = mk({});
    c.set('keep', 'v', { ttlMs: 60000 });
    c.set('plain', 'v');
    native.sweepExpired(0, 1 << 16);
    c.clearLocal();
    ok(c.get('keep') === 'v', 'a sweep does not evict an unexpired TTL entry');
    ok(c.get('plain') === 'v', 'a sweep does not evict an entry with no TTL');
    c.close();
}

// The API promises set() never throws and returns a boolean. It threw for a
// Symbol key (`this.#ns + key`), for an object whose toString throws, and for an
// options object whose ttlMs getter throws -- all caller-supplied code running
// inside a method documented not to throw. Non-string keys were also coerced
// silently, so set(undefined, v) stored under 'undefined' and every plain object
// aliased to '[object Object]'.
{
    const c = mk({});
    const noThrow = (fn) => { try { return { v: fn() }; } catch (e) { return { threw: e.constructor.name }; } };
    for (const [label, fn] of [
        ['Symbol key', () => c.set(Symbol('s'), 'v')],
        ['key whose toString throws', () => c.set({ toString() { throw new Error('x'); } }, 'v')],
        ['options whose ttlMs getter throws', () => c.set('k', 'v', { get ttlMs() { throw new Error('x'); } })],
        ['undefined key', () => c.set(undefined, 'v')],
        ['plain object key', () => c.set({}, 'v')],
    ]) {
        const r = noThrow(fn);
        ok(r.threw === undefined && r.v === false, `set: ${label} -> false, not a throw (${JSON.stringify(r)})`);
    }
    ok(noThrow(() => c.get(Symbol('s'))).v === undefined, 'get: a Symbol key is a miss, not a throw');
    ok(noThrow(() => c.has(Symbol('s'))).v === false, 'has: a Symbol key is false, not a throw');
    ok(noThrow(() => c.delete(Symbol('s'))).v === false, 'delete: a Symbol key is false, not a throw');
    c.set('real', 'v');
    ok(c.get('real') === 'v', 'a normal string key still works');
    c.close();
}

console.log(fails ? `\n  ${fails} FAILED` : '\n  all passed');
process.exit(fails ? 1 : 0);
