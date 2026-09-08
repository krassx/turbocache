'use strict';
// Single-process comparison. Neither cache has an IPC peer here, so nothing is
// waiting on a later tick and the workload does not yield the event loop.
const { run, buildPlan, BUGSEE } = require('./workload');
const { TurboCache } = require('../prototype/turbocache');
const bugsee = require(BUGSEE);

const OPS = Number(process.env.OPS || 300000);
const L1 = 2 * 1024 * 1024;
const L2 = 256 * 1024 * 1024;
const NOYIELD = 0;

const head = () => console.log('  implementation                throughput      wall   hit rate      p50      p99     p99.9');
function report(name, r, extra) {
    console.log('  ' + name.padEnd(26) +
        (r.opsPerSec / 1000).toFixed(0).padStart(8) + 'k ops/s' +
        r.ms.toFixed(0).padStart(8) + 'ms' +
        (r.hitRate * 100).toFixed(1).padStart(9) + '%' +
        String(r.p50).padStart(9) + String(r.p99).padStart(9) + String(r.p999).padStart(10) +
        (extra ? '   ' + extra : ''));
}

// turbocache stores bytes, so the application owns the codec. JSON.parse /
// JSON.stringify are charged to it here, exactly as an app would pay.
const tcObj = c => ({ sync: true,
    get: k => { const s = c.get(k); return s === undefined ? undefined : JSON.parse(s); },
    set: (k, v) => c.set(k, JSON.stringify(v)) });
const tcStr = c => ({ sync: true, get: k => c.get(k), set: (k, v) => c.set(k, v) });
// codec mode: the cache owns encode/decode, so L1 holds the decoded object and
// an L1 hit skips JSON entirely. L2 still stores bytes only.
const JSONC = { encode: JSON.stringify, decode: JSON.parse };
const bs = c => ({ sync: false, get: k => c.get(k), set: (k, v) => c.set(k, v) });

let n = 0;
const fresh = (opts) => TurboCache.createPrimary('/tc-sng-' + process.pid + '-' + (n++), L2, 1 << 20, opts);

(async () => {
    console.log(`single process: ops=${OPS} zipf s=1.0, 90% read / 10% write, cache-aside`);
    console.log(`sizes: L1=${L1/1048576}MB  L2=${L2/1048576}MB (identical for both)`);
    const noop = { sync: true, get: () => 'x', set: () => {} };

    for (const [title, nkeys, seed] of [
        ['A: 60000-key working set (exceeds L1, exercises L2)', 60000, 42],
        ['B: 1000-key hot set (fits in L1, isolates the L1 path)', 1000, 7]
    ]) {
        console.log(`\n=== scenario ${title} | object values ===`);
        const plan = buildPlan({ ops: OPS, nkeys, seed });
        head();
        report('(harness floor, no cache)', await run(noop, plan, 256, NOYIELD));
        let tc = fresh();
        report('turbocache (sync)', await run(tcObj(tc), plan, 256, NOYIELD),
               `L1hit=${tc.stats.l1Hits} L2hit=${tc.stats.l2Hits}`);
        TurboCache.native().destroy();
        tc = fresh();
        const a = tcObj(tc);
        report('turbocache (awaited)', await run({ sync: false, get: async k => a.get(k), set: async (k, v) => a.set(k, v) }, plan, 256, NOYIELD));
        TurboCache.native().destroy();

        tc = fresh({ codec: JSONC, l1MaxBytes: L1 });
        report('turbocache (codec)', await run(tcStr(tc), plan, 256, NOYIELD),
               `L1hit=${tc.stats.l1Hits} L2hit=${tc.stats.l2Hits}`);
        TurboCache.native().destroy();

        tc = fresh({ codec: JSONC, l1MaxBytes: L1, freeze: true });
        report('turbocache (codec, frozen)', await run(tcStr(tc), plan, 256, NOYIELD));
        TurboCache.native().destroy();

        report('bugsee (L1 only)', await run(bs(new bugsee.Cache({ l1MaxBytes: L1, enableIpc: false })), plan, 256, NOYIELD));
    }

    // Opaque payloads (rendered HTML, serialized responses). turbocache stores
    // them verbatim; bugsee's API is JSON-only so it must still encode.
    console.log(`\n=== scenario C: 60000-key working set | opaque string values ===`);
    const planC = buildPlan({ ops: OPS, nkeys: 60000, seed: 42 });
    for (let i = 0; i < planC.vals.length; i++) planC.vals[i] = JSON.stringify(planC.vals[i]);
    head();
    report('(harness floor, no cache)', await run(noop, planC, 256, NOYIELD));
    let tcC = fresh();
    report('turbocache (raw bytes)', await run(tcStr(tcC), planC, 256, NOYIELD));
    TurboCache.native().destroy();
    tcC = fresh({ values: 'primitives', l1MaxBytes: L1 });
    report('turbocache (primitives)', await run(tcStr(tcC), planC, 256, NOYIELD),
           'exact accounting + flatten');
    TurboCache.native().destroy();
    report('bugsee (L1 only)', await run(bs(new bugsee.Cache({ l1MaxBytes: L1, enableIpc: false })), planC, 256, NOYIELD));

    console.log(`\n  latency ns/op, sampled 1 in 256, includes ~30ns hrtime overhead.`);
    console.log(`  bugsee has no L2 in a single process: its miss path ends at L1.`);
})();
