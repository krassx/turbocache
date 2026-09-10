'use strict';
// Runs the JS suite. `npm test` needs one entry point, and listing the files in
// three places (here, CI, and by hand) is how a test stops being run without
// anyone noticing - so CI calls this too.
const { execFileSync } = require('child_process');
const path = require('path');

const SUITE = [
    'test.js', 'api_test.js', 'codec_test.js', 'prim_test.js', 'json_fastpath_test.js',
    'v8codec_test.js', 'storage_modes_test.js', 'namespace_test.js', 'cluster_api_test.js',
    'review_regression_test.js', 'gaps_test.js', 'typeflow_test.js', 'typematrix_test.js',
    'perf_regression_test.js', 'guard_test.js', 'recovery_test.js',
];
// Same file, both transports: the shared-memory path is the default and the IPC
// path is the fallback, and a regression in either is a regression.
const MATRIX = [['transport_regression_test.js', { TC_T: 'shm' }], ['transport_regression_test.js', { TC_T: 'ipc' }]];

let failed = [];
const run = (file, env) => {
    const label = file + (env && env.TC_T ? ` [${env.TC_T}]` : '');
    process.stdout.write(`--- ${label}\n`);
    try { execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit', env: { ...process.env, ...env } }); }
    catch { failed.push(label); }
};
for (const f of SUITE) run(f, null);
for (const [f, env] of MATRIX) run(f, env);

if (failed.length) { console.error(`\nFAILED: ${failed.join(', ')}`); process.exit(1); }
console.log('\nall suites passed');
