// Cross-process regressions that only reproduce with a REAL worker: the two
// defects here were invisible to every in-process test, and one of them
// (close() losing queued writes) differed between the two transports, so both
// are exercised.
const { fork } = require('child_process');
const ARENA = process.env.TC_ARENA || ('/tcwl' + process.pid);
const T = process.env.TC_T || 'shm';
const P = require.resolve('../src/turbokv.js');

if (process.env.TC_ROLE === 'primary') {
    const { TurboKV } = require(P);
    // maintenance:false so the test owns the heartbeat and can stop it.
    const c = TurboKV.createPrimary(ARENA, 16 << 20, 1 << 14, { storage: 'bytes', transport: T, maintenance: false });
    c.set('seed', 'from-primary');
    const cluster = require('cluster');
    TurboKV.install(cluster);
    const hb = setInterval(() => { try { require('../src/native').heartbeat(); } catch {} }, 300);
    process.on('message', (m) => {
        if (!m) return;
        if (m.t === 'stopHeartbeat') clearInterval(hb);
        if (m.t === 'forkCloser') {
            // The PRIMARY forks it, so the child is a cluster worker and the IPC
            // transport has a channel to the primary. Forking it as a sibling of
            // the primary (which the runner would do) leaves the two with no
            // channel at all, so the ipc path could never deliver and the test
            // would be measuring the harness.
            cluster.setupPrimary({ exec: __filename });
            const w = cluster.fork({ TC_ROLE: 'closer', TC_ARENA: ARENA, TC_T: T });
            w.on('message', (cm) => {
                if (!cm || cm.t !== 'closed') return;
                setTimeout(() => {
                    let g = 0; while (TurboKV.drainSubmissions(8192) > 0 && ++g < 64);
                    process.send({ t: 'readback', sibOk: cm.sibOk,
                                   w1: c.get('w1'), seed: c.get('seed'), sib: c.get('sib') });
                    w.kill();
                }, 400);
            });
        }
    });
    process.send({ t: 'up' });
    setInterval(() => {}, 1000);
} else if (process.env.TC_ROLE === 'writeonly') {
    const { TurboKV } = require(P);
    const c = TurboKV.attachWorker(ARENA, 1, { storage: 'bytes', transport: T, primaryStaleMs: 1500 });
    let i = 0;
    setInterval(() => { c.set('wo' + (i++), 'v'); process.send({ t: 'p', dead: c.primaryDead === true }); }, 200);
} else if (process.env.TC_ROLE === 'closer') {
    const { TurboKV } = require(P);
    const a = TurboKV.attachWorker(ARENA, 1, { storage: 'bytes', transport: T });
    const b = TurboKV.attachWorker(ARENA, 1, { storage: 'bytes', transport: T });
    a.set('w1', 'queued-before-close');
    a.delete('seed');
    a.close();                                    // b is still live
    const sibOk = b.set('sib', 'after-sibling-close');
    b.flush();
    setTimeout(() => process.send({ t: 'closed', sibOk, transport: b.transport }), 300);
} else {
    let fails = 0;
    const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  [${T}] ${m}`); if (!c) fails++; };
    const F = (role) => fork(__filename, [], { env: { ...process.env, TC_ROLE: role, TC_ARENA: ARENA, TC_T: T }, stdio: 'inherit' });
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    (async () => {
        // 1. close() must not destroy writes already queued, and must not break
        //    a sibling instance in the same process.
        let prim = F('primary');
        await new Promise(r => prim.once('message', r));
        prim.send({ t: 'forkCloser' });
        const rb = await new Promise(r => prim.on('message', m => m.t === 'readback' && r(m)));
        ok(rb.w1 === 'queued-before-close', 'a write queued before close() still reaches L2');
        ok(rb.seed === undefined, 'a delete queued before close() is still applied');
        ok(rb.sibOk === true && rb.sib === 'after-sibling-close',
           "a sibling instance keeps working after another instance's close()");
        prim.kill('SIGKILL');
        await wait(300);

        // 2. A worker that ONLY writes must still notice its primary died.
        //    The staleness check used to live only on the read path.
        prim = F('primary');
        await new Promise(r => prim.once('message', r));
        const wo = F('writeonly');
        let sawDead = false;
        wo.on('message', m => { if (m.t === 'p' && m.dead) sawDead = true; });
        await wait(1200);
        ok(!sawDead, 'a write-only worker is not degraded while the primary is healthy');
        prim.kill('SIGKILL');
        await wait(5000);
        ok(sawDead, 'a write-only worker detects primary death without ever reading');
        wo.kill('SIGKILL');

        console.log(fails ? `\n  [${T}] ${fails} FAILED` : `\n  [${T}] all passed`);
        process.exit(fails ? 1 : 0);
    })();
    setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
}
