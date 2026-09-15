'use strict';
// Preloaded into every test process by run.js.
//
// A POSIX shared-memory segment outlives the process that created it until
// something unlinks it -- that is the whole point of the arena, and it is
// correct for a live primary. It is wrong for a test: the suite is ~24
// processes, each leaving its last arena and submission ring behind, so a run
// accumulated well over a gigabyte of /dev/shm. Invisible on a developer
// machine and on CI VMs, where /dev/shm is half of RAM; fatal in a container,
// where Docker defaults it to 64MB.
//
// Doing this here rather than in 24 files means a test added tomorrow cannot
// forget. It is a no-op unless the test actually loaded the addon: destroy()
// on a Store that was never created does nothing, and on a worker's read-only
// attach it closes the mapping without unlinking a segment it does not own.
process.on('exit', () => {
    let mod;
    try { mod = require.cache[require.resolve('../src/native')]; } catch { return; }
    if (!mod) return;                       // this process never loaded the addon
    try { mod.exports.submitDestroy(); } catch { /* no ring here */ }
    try { mod.exports.destroy(); } catch { /* no arena here */ }
});
