'use strict';
const { run, buildPlan, BUGSEE } = require('./workload');
const { TurboCache } = require('../src/turbocache');
const { TURBO_MODES, turboOpts, turboAdapter, bugseeAdapter } = require('./adapters');
const bugsee = require(BUGSEE);

const OPS = Number(process.env.OPS || 200000);
const L1 = 2 << 20, L2 = 256 << 20;
let seq = 0;
const fresh = o => TurboCache.createPrimary('/tcsm' + process.pid + '_' + (seq++), L2, 1 << 20, o);

const SHAPES = [
    ['reads dominate, fits L1',   1000,  0.01],
    ['mixed 90/10, exceeds L1',   60000, 0.10],
    ['write-heavy 50/50',         60000, 0.50]
];

(async () => {
    console.log(`SINGLE PROCESS — ${OPS} ops, L1=${L1 >> 20}MB, L2=${L2 >> 20}MB, zipf s=1.0`);
    console.log('values are objects; `bytes` has no codec so the app encodes, charged to it\n');
    console.log('  workload                     ' + [...TURBO_MODES, 'bugsee'].map(m => m.padEnd(17)).join(''));
    for (const [label, nkeys, writeRatio] of SHAPES) {
        const plan = buildPlan({ ops: OPS, nkeys, seed: 31, writeRatio });
        const cells = [];
        for (const mode of TURBO_MODES) {
            const c = fresh(turboOpts(mode, L1));
            const r = await run(turboAdapter(mode, c), plan, 256, 0);
            cells.push(`${(r.opsPerSec / 1000).toFixed(0)}k/${(r.hitRate * 100).toFixed(0)}%`.padEnd(17));
            c.close();
        }
        const bc = new bugsee.Cache({ l1MaxBytes: L1, enableIpc: false });
        const rb = await run(bugseeAdapter(bc), plan, 256, 0);
        cells.push(`${(rb.opsPerSec / 1000).toFixed(0)}k/${(rb.hitRate * 100).toFixed(0)}%`);
        console.log('  ' + label.padEnd(29) + cells.join(''));
    }
    console.log('\n  cells are throughput / hit rate. bugsee has no L2 in a single process,');
    console.log('  so its misses end at L1 and cost nothing here.');
})();
