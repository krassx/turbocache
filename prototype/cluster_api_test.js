// Cache.install(cluster) must be all the wiring a primary needs.
const cluster = require('cluster');
const { TurboCache } = require('./turbocache');

if (cluster.isPrimary) {
    const cache = TurboCache.open({ storage: 'bytes' });
    TurboCache.install(cluster);                       // the entire primary-side setup
    cache.set('from-primary', 'hello');

    let done = 0, fail = 0;
    for (let i = 0; i < 3; i++) {
        const w = cluster.fork();
        w.on('message', m => {
            if (!m || m.t !== 'r') return;
            if (!m.ok) { fail++; console.log('  FAIL:', m.why); }
            if (++done === 3) {
                // a worker's write must have reached the shared arena
                const seen = cache.get('from-worker-1');
                if (seen !== 'w1') { fail++; console.log('  FAIL: primary cannot see worker write, got', seen); }
                console.log(fail ? `  ${fail} FAILURES` : '  all passed');
                for (const id in cluster.workers) cluster.workers[id].kill();
                cache.close();
                process.exit(fail ? 1 : 0);
            }
        });
    }
} else {
    const cache = TurboCache.open({ storage: 'bytes' });   // auto-attaches
    const id = cluster.worker.id;
    const checks = [];
    checks.push([cache.get('from-primary') === 'hello', 'worker reads what the primary wrote']);
    cache.set('from-worker-' + id, 'w' + id);
    checks.push([cache.get('from-worker-' + id) === 'w' + id, 'worker reads its own write from L1']);
    checks.push([cache.has('from-primary') === true, 'has() works in a worker']);
    // a worker must not report success for something the primary would drop
    checks.push([cache.set('oversized', 'x'.repeat(80 * 1024 * 1024)) === false,
                 'worker rejects an oversized value at the call site']);
    checks.push([cache.set('sized-ok', 'y') === true, 'worker accepts a normal value']);
    cache.flush();                                             // push the batch to the primary
    setTimeout(() => {
        const bad = checks.find(c => !c[0]);
        process.send({ t: 'r', ok: !bad, why: bad && bad[1] });
    }, 250);
}
