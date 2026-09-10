// Primary death and recovery.
//
// Uses child_process.fork rather than cluster, because under cluster a worker
// dies with its primary and the interesting cases never arise. That is also the
// honest scope of this feature: the "a NEW primary appeared" half matters only
// for supervisor-managed deployments, while the "the SAME primary was stalled"
// half (a long GC, SIGSTOP, a laptop sleep) matters everywhere and was a
// permanent outage before this.
const { fork } = require('child_process');
const path = require('path');
// The name must be shared by every process in the test: each fork has its own
// pid, so deriving it from process.pid gave the primary and the worker
// different arenas and the worker simply could not attach.
const ARENA = process.env.TC_ARENA || ('/tcrecov' + process.pid);

if (process.env.TC_ROLE === 'primary') {
    const { TurboCache } = require('./turbocache');
    // maintenance:false so this test OWNS the heartbeat. The library's own
    // maintenance timer stamps it independently, so pausing a second interval
    // alongside it stalls nothing - SIGSTOP only appeared to work because it
    // froze the whole process, library timer included.
    const c = TurboCache.createPrimary(ARENA, 16 << 20, 1 << 14, { storage: 'bytes', maintenance: false });
    c.set('k', process.env.TC_VALUE);
    // A stalled primary is simulated by pausing the heartbeat rather than by
    // SIGSTOP: signals are the wrong tool here. SIGSTOP does not exist on
    // Windows (ERR_UNKNOWN_SIGNAL), and pausing the stamp exercises exactly the
    // code path under test - a worker seeing the heartbeat go stale - on every
    // platform, without freezing a process the harness still needs to talk to.
    let paused = 0;
    setInterval(() => {
        if (Date.now() < paused) return;
        try { require('./build/Release/l2.node').heartbeat(); } catch {}
    }, 500);
    process.on('message', (m) => { if (m && m.t === 'stall') paused = Date.now() + m.ms; });
    process.send({ t: 'up' });
    setInterval(() => {}, 1000);
} else if (process.env.TC_ROLE === 'worker') {
    const { TurboCache } = require('./turbocache');
    const c = TurboCache.attachWorker(ARENA, 1, { storage: 'bytes', primaryStaleMs: 2000 });
    c.get('k');                                    // warm L1 so degraded reads still work
    process.send({ t: 'ready' });
    setInterval(() => {
        process.send({
            t: 'poll', v: c.get('k'), dead: !!c.lastError && /serving L1 only/.test(c.lastError),
            recoveries: c.stats.recoveries || 0, last: c.stats.lastRecovery || null,
            transport: c.transport,
        });
    }, 300);
} else {
    let fails = 0;
    const ok = (cnd, m) => { console.log(`  ${cnd ? 'ok  ' : 'FAIL'}  ${m}`); if (!cnd) fails++; };
    const F = (role, env = {}) => fork(__filename, [], { env: { ...process.env, TC_ROLE: role, TC_ARENA: ARENA, ...env }, stdio: 'inherit' });
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    let last = {};

    (async () => {
        let prim = F('primary', { TC_VALUE: 'FIRST' });
        await new Promise(r => prim.once('message', r));
        const w = F('worker');
        let sawDead = false;
    w.on('message', m => { if (m.t === 'poll') { last = m; if (m.dead) sawDead = true; } });
        await new Promise(r => w.once('message', r));
        await wait(600);
        ok(last.v === 'FIRST' && !last.dead, 'worker reads through a live primary');

        // 1. primary dies; the worker must degrade but keep serving L1
        prim.kill('SIGKILL');
        await wait(4000);
        ok(last.dead === true, 'worker degrades after the primary dies');
        ok(last.v === 'FIRST', 'a degraded worker still serves its warm L1');

        // 2. a DIFFERENT primary takes over the name
        prim = F('primary', { TC_VALUE: 'SECOND' });
        await new Promise(r => prim.once('message', r));
        await wait(5000);
        // `dead === false` alone passes when the worker NEVER degraded, which is how
        // an earlier run reported a recovery that had not happened.
        ok(sawDead && last.dead === false, 'worker recovers once a new primary is live');
        ok(last.recoveries === 1, `exactly one recovery (got ${last.recoveries})`);
        ok(last.last && last.last.sameArena === false, 'recovery is reported against a DIFFERENT arena');
        ok(last.v === 'SECOND', 'L1 was flushed, so the new primary\'s value is visible');
        ok(last.transport === 'shm', 'the submission ring was re-claimed after recovery');

        // 3. the SAME primary merely stalls: recover, and do not double-count
        sawDead = false;
        prim.send({ t: 'stall', ms: 4000 });
        await wait(4500);
        ok(last.dead === true, 'a stalled primary degrades the worker');
        await wait(5000);          // the stall lapses on its own; the primary resumes stamping
        ok(sawDead && last.dead === false, 'worker recovers when the same primary resumes');
        ok(last.recoveries === 2 && last.last.sameArena === true,
           `resume is recognised as the SAME arena (recoveries=${last.recoveries}, same=${last.last && last.last.sameArena})`);

        // 4. no flapping against a healthy primary
        const before = last.recoveries;
        await wait(6000);
        ok(last.recoveries === before && last.dead === false,
           `no spurious degrade over 6s of healthy operation (${before} -> ${last.recoveries})`);

        prim.kill('SIGKILL'); w.kill('SIGKILL');
        console.log(fails ? `\n${fails} FAILED` : '\nall passed');
        process.exit(fails ? 1 : 0);
    })();
    setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
}
