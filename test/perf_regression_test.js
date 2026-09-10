// Performance regressions that a correctness suite cannot see: algorithms that
// are correct but scale wrong. Assertions are RATIOS between configurations
// measured in the same process, never absolute times, so a slow or loaded CI
// machine moves both sides together and the test stays meaningful.
const { TurboCache } = require('../src/turbocache');
let fail = 0, n = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// L1 eviction must be O(1) in the number of resident entries.
//
// It was O(n): the eviction loop found the oldest entry with a FRESH
// `map.entries().next()`, and V8's OrderedHashMap tombstones deletions rather
// than compacting, so every call re-scanned the accumulated run of holes at the
// front. A cold-read workload therefore got *slower* as L1 got bigger --
// 2832ns/read at 2MB against 23664ns at 32MB -- which is backwards: more cache
// should never cost more per operation.
{
    // The cold set (~150k x ~250B = 37MB) must exceed BOTH L1 sizes, or the
    // larger one simply holds everything, never evicts, and the comparison
    // measures nothing -- an earlier version of this test passed happily with
    // the fix reverted for exactly that reason.
    const COLD = 150000, N = 60000, FILL = 'f'.repeat(160);
    const cost = (l1mb) => {
        const c = TurboCache.createPrimary(`/tcperf${process.pid}_${n++}`, 128 << 20, 1 << 19,
            { storage: 'bytes', l1MaxBytes: l1mb << 20 });
        for (let i = 0; i < COLD; i++) c.set('cold:' + i, `cold:${i}#1#${FILL}`);
        let sink = 0;
        for (let i = 0; i < 10000; i++) { const v = c.get('cold:' + ((Math.random() * COLD) | 0)); if (v) sink += v.length; }
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < N; i++) { const v = c.get('cold:' + ((Math.random() * COLD) | 0)); if (v) sink += v.length; }
        const ns = Number(process.hrtime.bigint() - t0) / N;
        c.close();
        return sink >= 0 ? ns : ns;
    };
    const small = cost(2), large = cost(16);   // 8x the resident entries, both evicting
    const ratio = large / small;
    console.log(`  L1=2MB ${small.toFixed(0)}ns/read   L1=16MB ${large.toFixed(0)}ns/read   ratio ${ratio.toFixed(2)}x`);
    // 8x the resident entries. O(n) eviction made the larger L1 several times
    // more expensive per read; O(1) makes the two comparable. 2.5x is generous
    // enough to absorb cache-locality effects without letting O(n) back in.
    ok(ratio < 2.5, 'cold-read cost does not grow with L1 size (eviction is not O(n))');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
