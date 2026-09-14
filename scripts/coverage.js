'use strict';
// Entry point for `npm run coverage`.
//
// The hook has to reach every process, not just this one: run.js spawns each
// test file as a child and the tests fork cluster workers, and it is the
// worker-side code that would otherwise go unmeasured. `--require` on the
// command line applies only to the process that receives it, so the hook is
// passed through NODE_OPTIONS, which children inherit. Setting it here rather
// than in the npm script keeps it portable -- `FOO=bar cmd` is not valid on
// Windows shells.
const path = require('path');
const { execFileSync } = require('child_process');

const hook = path.join(__dirname, 'coverage-hook.js');
const existing = process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '';
process.env.NODE_OPTIONS = `${existing}--require ${JSON.stringify(hook)}`;

try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')],
                 { stdio: 'inherit', env: process.env });
} catch (e) {
    process.exit(typeof e.status === 'number' ? e.status : 1);
}
