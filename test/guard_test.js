// The post-GC heap guard must actually fire, on every runtime.
//
// It used to hang off a gc PerformanceObserver, which Node emits and Bun and
// Deno silently do not - so the guard was inert on two of three runtimes and
// nothing said so. The signal is a FinalizationRegistry now, with a floor poll
// behind it. This test asserts the guard runs and sheds; being green on Node
// alone would prove nothing, so run it under bun/deno too.
const { TurboCache } = require('../src/turbocache');

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fails++; };
const rt = typeof Bun !== 'undefined' ? 'bun' : (typeof Deno !== 'undefined' ? 'deno' : 'node');

(async () => {
    // maxHeapFraction 0.0001 makes any live heap "too much", so the guard fires
    // as soon as it receives a reading. What is under test is the SIGNAL, not
    // the threshold arithmetic.
    const c = TurboCache.createPrimary('/tcguard' + process.pid, 32 << 20, 1 << 16,
        { storage: 'bytes', l1MaxBytes: 8 << 20, heapGuard: { maxHeapFraction: 0.0001, shedFraction: 0.5 } });

    for (let i = 0; i < 20000; i++) c.set('k' + i, 'v'.repeat(200));   // fill L1
    const before = c.stats.heapShed || 0;

    // Churn WITH yields: a finalizer cannot run, and a timer cannot fire, inside
    // a synchronous loop. An earlier version of this measurement missed that and
    // concluded the guard never ran on any runtime.
    // Run until a signal arrives or 5s elapse. The window has to outlast the
    // BACKSTOP's cadence, not just the registry's: with a 600ms window this
    // passed on the finalizer path and silently never exercised the floor poll,
    // which ticks once a second. A test that can only ever see the fast path
    // would not notice the fallback rotting.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const junk = [];
        for (let i = 0; i < 30000; i++) junk.push({ i, s: 'g'.repeat(60) });
        if (junk.length < 0) throw new Error('unreachable');
        await new Promise(r => setTimeout(r, 15));
        if ((c.stats.heapShed || 0) > before && c.liveHeapFraction > 0) break;
    }

    ok(c.liveHeapFraction > 0, `[${rt}] the guard received a heap reading (liveHeapFraction=${c.liveHeapFraction.toExponential(2)})`);
    ok((c.stats.heapShed || 0) > before, `[${rt}] the guard shed L1 at least once (heapShed=${c.stats.heapShed || 0})`);

    // And it must not fire when the threshold is sane.
    const c2 = TurboCache.createPrimary('/tcguard2' + process.pid, 32 << 20, 1 << 16,
        { storage: 'bytes', l1MaxBytes: 1 << 20, heapGuard: { maxHeapFraction: 0.99 } });
    for (let i = 0; i < 2000; i++) c2.set('k' + i, 'v'.repeat(200));
    await new Promise(r => setTimeout(r, 1500));
    ok(!(c2.stats.heapShed > 0), `[${rt}] no shedding at a 0.99 threshold (heapShed=${c2.stats.heapShed || 0})`);
    c2.close();
    c.close();

    console.log(fails ? `\n  ${fails} FAILED` : '\n  all passed');
    process.exit(fails ? 1 : 0);
})();
