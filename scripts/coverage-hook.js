'use strict';
// Preloaded into every process during a coverage run (see scripts/coverage.js).
//
// V8 writes the data NODE_V8_COVERAGE collects when a process ends normally --
// including via an explicit process.exit(), which this suite uses. What it does
// NOT survive is a signal: measured, SIGTERM and SIGKILL both write nothing.
// The suite ends its cluster workers with worker.kill(), which sends SIGTERM, so
// the worker-side half of the JS layer -- the IPC outbox, the submission-ring
// client, degrade and recover -- was being discarded and reported as untested.
//
// So: handle the signals that can be handled, and nothing else.
//
// Do NOT also wrap process.exit to flush. v8.takeCoverage() writes a snapshot
// and RESETS the counters, so flushing before a normal exit makes Node's own
// exit-time write a second, all-zero record for the same file -- and the merged
// report then shows 0%. That mistake is how index.js and index.mjs appeared
// completely uncovered while a test was demonstrably loading both.
if (process.env.NODE_V8_COVERAGE) {
    const v8 = require('v8');
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        process.on(sig, () => {
            try { v8.takeCoverage(); } catch { /* nothing collected yet */ }
            process.reallyExit(0);      // not process.exit: no second write
        });
    }
}
