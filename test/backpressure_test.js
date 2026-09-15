// The IPC write path under backpressure, and the no-heartbeat primary.
//
// Both are worker-side behaviours with a history. The in-flight byte window is
// what stopped a worker's RSS growing past 485MB while its JS heap stayed flat
// -- process.send() queues into libuv, which is unbounded, so the bound has to
// be on bytes outstanding rather than on "is a message in flight". And the
// `age === -1` heartbeat case is not death but "never stamped": treating it as
// death degraded every worker permanently on its second read against a primary
// running with maintenance:false.
//
// Neither had a test. Coverage found them: the window's shed branch and the
// -1 branch were both unexecuted by the whole suite.
const cluster = require('cluster');
const { TurboKV } = require('../src/turbokv');
const native = require('../src/native');


// Wait for workers to actually EXIT, rather than guessing with a timer. Under
// coverage a worker flushes on SIGTERM, and a parent that exits first kills the
// flush -- which made measured coverage swing by 4.5 points between runs.
function reapThen(workers, done) {
    const list = [...workers];
    if (!list.length) return done();
    let left = list.length;
    const one = () => { if (--left === 0) done(); };
    // ASK them to leave, do not signal them. V8 writes coverage on a normal
    // exit; the SIGTERM handler is a backstop that has to win a race, and
    // losing it moved whole-suite coverage by more than a point between runs.
    const guard = setTimeout(() => { for (const wk of list) wk.kill('SIGTERM'); }, 3000);
    guard.unref && guard.unref();
    for (const wk of list) { wk.once('exit', one); try { wk.send({ t: 'bye' }); } catch { wk.kill('SIGTERM'); } }
}

const ARENA = '/tcbp_' + process.pid;

if (cluster.isPrimary && !process.env.TC_CHILD) {
    let fails = 0;
    const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fails++; };

    // maintenance:false means this primary never stamps a heartbeat, which is
    // exactly the condition the worker has to tell apart from death.
    TurboKV.createPrimary(ARENA, 32 << 20, 1 << 16,
                             { storage: 'bytes', transport: 'ipc', maintenance: false });
    TurboKV.install(cluster);

    const w = cluster.fork({ TC_CHILD: '1', TC_ARENA: ARENA });
    w.on('message', (m) => {
        if (!m || m.t !== 'done') return;

        ok(m.shed > 0,
           `a worker whose send window is full SHEDS writes rather than growing (shed=${m.shed})`);
        ok(/window full/i.test(m.shedError || ''),
           `the shed is reported in lastError (got ${JSON.stringify(m.shedError)})`);
        ok(m.l1Value === 'V',
           'a shed write still serves from the WRITER\'s own L1 (shed is not data loss for it)');
        ok(m.deadAfterShed === false,
           'shedding does not mark the primary dead');

        ok(m.dropped > 0,
           `a synchronous throw from process.send is counted, not swallowed (flushDropped=${m.dropped})`);
        ok(/channel closed|ERR_IPC_CHANNEL_CLOSED/.test(m.throwErr || ''),
           `the throw is reported in lastError (got ${JSON.stringify(m.throwErr)})`);
        ok(m.sentAfterThrow > 0,
           'the in-flight window is returned after a throw, so the worker keeps writing');

        ok(m.noHeartbeatError !== null && /never stamped a heartbeat/.test(m.noHeartbeatError),
           `a primary that never stamps is reported as such, not as dead (${m.noHeartbeatError})`);
        ok(m.degradedByNoHeartbeat === false,
           'a worker does NOT degrade against a primary running maintenance:false');

        reapThen(Object.values(cluster.workers), () => {
            native.destroy();
            console.log(fails ? `  ${fails} FAILURES` : '  all passed');
            process.exit(fails ? 1 : 0);
        });
    });
    setTimeout(() => { console.log('  TIMEOUT'); process.exit(1); }, 30000);
} else {
    // --- worker
    const c = TurboKV.attachWorker(process.env.TC_ARENA, cluster.worker.id,
        { storage: 'bytes', transport: 'ipc',
          // Tiny window and tiny outbox, so a modest burst reaches the state that
          // needs both to be full: the window exhausted AND nowhere left to batch.
          maxInFlightBytes: 1024, outboxMaxBytes: 2048 });

    // --- a synchronous throw from process.send must not wedge the worker.
    // The bytes for a batch are reserved before the send; if the send throws
    // they have to be given back, or the in-flight window shrinks by that much
    // forever and the worker eventually stops writing to L2 altogether.
    const realSend = process.send.bind(process);
    process.send = () => { const e = new Error('channel closed'); e.code = 'ERR_IPC_CHANNEL_CLOSED'; throw e; };
    let throwErr = null, dropped = 0;
    try {
        c.set('boom', 'X');
        c.flush();
        dropped = c.stats.flushDropped || 0;
        throwErr = c.lastError;
    } finally { process.send = realSend; }

    // The window must have recovered: a write after the throw still reaches L2.
    c.set('after-throw', 'Y');
    c.flush();
    const sentAfterThrow = c.stats.sent || 0;

    for (let i = 0; i < 4000; i++) c.set('k' + i, 'V'.repeat(64));
    c.set('mine', 'V');

    const shed = c.stats.writesShed || 0;
    const shedError = c.lastError;

    // Two reads spaced past the staleness gate: the -1 branch is reached on a
    // read, and only once per 500ms.
    process.on('message', (m) => { if (m && m.t === 'bye') process.exit(0); });

    c.get('mine');
    setTimeout(() => {
        c.get('mine');
        process.send({
            t: 'done',
            dropped, throwErr, sentAfterThrow,
            shed,
            shedError,
            l1Value: c.get('mine'),
            deadAfterShed: c.primaryDead === true,
            noHeartbeatError: c.lastError,
            degradedByNoHeartbeat: c.primaryDead === true,
        });
    }, 700);
}
