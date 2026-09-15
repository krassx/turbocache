// Creating an arena must release the one this process already owned.
//
// `native` is process-global: a second create() REPLACES the first. Until it
// did so explicitly, the old mapping AND its /dev/shm name both survived for
// the life of the process, so a suite that creates an arena per test
// accumulated every one of them. That is invisible on a developer machine and
// on CI VMs, where /dev/shm is half of RAM -- and fatal in a container, where
// Docker defaults it to 64MB. The musl release job failed exactly this way.
//
// The leak can only be seen from OUTSIDE the process that made it: a leaked
// segment is one still attachable after its creator exits. So this file runs a
// child that creates many arenas, then scans for them from the parent.
const { execFileSync } = require('child_process');
const path = require('path');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const N = 12;
// Passed to the child, NOT recomputed there: process.pid differs between the
// two, so deriving it independently had the parent scanning names the child
// never created -- a test that could only ever report zero leaks.
const PREFIX = process.env.TC_LEAK_PREFIX || ('/tcleak' + process.pid + '_');

if (process.env.TC_LEAK_CHILD) {
    const { TurboKV } = require('../src/turbokv');
    // Each call replaces the last. Only the final arena should still exist.
    for (let i = 0; i < N; i++) {
        TurboKV.createPrimary(PREFIX + i, 8 << 20, 1 << 13, { storage: 'bytes' });
    }
    process.exit(0);
}

execFileSync(process.execPath, [__filename],
             { env: { ...process.env, TC_LEAK_CHILD: '1', TC_LEAK_PREFIX: PREFIX },
               stdio: 'inherit' });

// The child is gone. Anything still attachable is a segment it failed to release.
const native = require('../src/native');
const leaked = [];
for (let i = 0; i < N; i++) {
    try { if (native.attach(PREFIX + i)) leaked.push(PREFIX + i); } catch { /* not there */ }
}
native.detach && native.detach();

// The LAST arena is still linked on purpose: a live primary's segment outlives
// the process so a restarting primary can find it. Every earlier one was
// replaced and must be gone.
const stale = leaked.filter(n => n !== PREFIX + (N - 1));
ok(stale.length === 0,
   `creating ${N} arenas leaves no stale segments behind (leaked ${stale.length}: ${stale.slice(0, 4).join(' ')})`);
ok(leaked.length <= 1,
   `at most the final arena survives the process (survived ${leaked.length})`);

console.log(fail ? `  ${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
