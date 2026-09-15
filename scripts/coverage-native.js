'use strict';
// json-fastpath-lint: allow -- this writes one human-readable artifact per run,
// where indentation is the point and the 2.11x cost of a `space` argument is
// irrelevant. The lint exists for the cache's hot paths.
// Native (C++) coverage: build instrumented, run the suites, summarise.
//
// Reports gcov data for src/ only. The headers matter most here -- store_ops.h,
// submit.h and platform.h are header-only and compiled into binding.cc, so gcov
// attributes their lines to the including translation unit and they show up as
// separate files in the report, which is what we want.
//
// gcov ships with the compiler, so there is no extra dependency: clang needs
// `llvm-cov gcov`, gcc has `gcov` directly.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OBJ = path.join(ROOT, 'build/Release/obj.target/turbokv/src');
const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });

// --- 1. instrumented build
console.log('--- building with --coverage');
run('npx', ['node-gyp', 'configure', 'build', '--turbokv_coverage=1'],
    { stdio: ['ignore', 'ignore', 'inherit'] });

// A .gcda accumulates across runs, so clear it or a stale run inflates the
// numbers and a deleted test still looks covered.
for (const f of fs.existsSync(OBJ) ? fs.readdirSync(OBJ) : []) {
    if (f.endsWith('.gcda')) fs.unlinkSync(path.join(OBJ, f));
}

// --- 2. exercise it
console.log('--- running the suite against the instrumented addon');
const suite = spawnSync(process.execPath, [path.join(ROOT, 'test', 'run.js')],
                        { cwd: ROOT, stdio: 'inherit' });

// --- 3. report
const gcov = spawnSync('gcov', ['--version'], { stdio: 'ignore' }).status === 0
    ? ['gcov', []]
    : ['xcrun', ['llvm-cov', 'gcov']];
const gcno = fs.readdirSync(OBJ).filter(f => f.endsWith('.gcno'));
if (!gcno.length) { console.error('no .gcno files: was the instrumented build skipped?'); process.exit(1); }

// gcov is run from build/, not from the object directory. The .gcno records the
// source as `../src/binding.cc`, which resolves only from a directory whose
// parent holds src/ -- run it anywhere else and gcov reports "No such file or
// directory" for every source and writes .gcov files containing no line data at
// all, which reads as 0% rather than as an error.
const GCOV_CWD = path.join(ROOT, 'build');
const rel = path.relative(GCOV_CWD, OBJ);
for (const f of fs.readdirSync(GCOV_CWD)) {
    if (f.endsWith('.gcov')) fs.unlinkSync(path.join(GCOV_CWD, f));
}
spawnSync(gcov[0], [...gcov[1], '-b', ...gcno.map(f => path.join(rel, f))],
          { cwd: GCOV_CWD, stdio: 'ignore' });

// Line hits are unioned across translation units. store_ops.h, submit.h and
// platform.h are header-only: they are compiled into the addon AND into each
// standalone C++ test, so each object file sees only the part its own TU uses.
// Reporting a single TU would understate them badly -- submit.h measures 51.85%
// from the addon alone while submit_test.cc is a dedicated test for it.
const hits = new Map();          // "file" -> Map(line -> covered)
const collect = (dir) => {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.gcov'))) {
        const name = f.replace(/\.gcov$/, '');
        if (!fs.existsSync(path.join(ROOT, 'src', name))) continue;   // ours only
        if (!hits.has(name)) hits.set(name, new Map());
        const lines = hits.get(name);
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
            const m = /^ *(#####|-|\d+)\*?: *(\d+):/.exec(line);
            if (!m || m[1] === '-' || m[2] === '0') continue;
            const n = Number(m[2]);
            lines.set(n, (lines.get(n) || false) || m[1] !== '#####');
        }
    }
};
collect(GCOV_CWD);

// --- the standalone C++ tests, built and run with the same instrumentation
const STANDALONE = [['native_regression_test.cc', []], ['submit_test.cc', ['-lpthread']]];
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tccov-'));
for (const [src, extra] of STANDALONE) {
    const bin = path.join(tmp, src.replace('.cc', ''));
    const cc = spawnSync('c++', ['-std=c++17', '-O0', '--coverage', '-Isrc', '-o', bin,
                                 path.join('test', src), ...extra],
                         { cwd: ROOT, stdio: 'ignore' });
    if (cc.status !== 0) { console.error(`  (skipped ${src}: failed to build instrumented)`); continue; }
    spawnSync(bin, [], { cwd: ROOT, stdio: 'ignore' });
}
// The .gcno/.gcda for these land next to the binary; gcov is run from ROOT so
// the recorded relative source paths (src/..., test/...) resolve.
const sgcno = fs.readdirSync(tmp).filter(f => f.endsWith('.gcno')).map(f => path.join(tmp, f));
if (sgcno.length) {
    for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.gcov')) fs.unlinkSync(path.join(ROOT, f));
    spawnSync(gcov[0], [...gcov[1], '-b', ...sgcno], { cwd: ROOT, stdio: 'ignore' });
    collect(ROOT);
    for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.gcov')) fs.unlinkSync(path.join(ROOT, f));
}
fs.rmSync(tmp, { recursive: true, force: true });

const rows = [];
for (const [name, lines] of hits) {
    const total = lines.size;
    const hit = [...lines.values()].filter(Boolean).length;
    if (total) rows.push({ name, total, hit, pct: (hit / total) * 100 });
}
rows.sort((a, b) => a.pct - b.pct);

const sum = rows.reduce((a, r) => ({ total: a.total + r.total, hit: a.hit + r.hit }), { total: 0, hit: 0 });
const pct = sum.total ? (sum.hit / sum.total) * 100 : 0;
console.log('\n  native line coverage (src/ only)');
for (const r of rows) {
    console.log(`    ${r.name.padEnd(16)} ${r.pct.toFixed(2).padStart(6)}%  (${r.hit}/${r.total})`);
}
console.log(`    ${'TOTAL'.padEnd(16)} ${pct.toFixed(2).padStart(6)}%  (${sum.hit}/${sum.total})`);

fs.mkdirSync(path.join(ROOT, 'coverage'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'coverage', 'native-summary.json'),
                 JSON.stringify({ total: { lines: { pct: +pct.toFixed(2), covered: sum.hit, total: sum.total } },
                                  files: rows }, null, 2) + '\n');

const floor = Number(process.env.TC_NATIVE_MIN || 0);
if (floor && pct < floor) {
    console.error(`\nnative coverage ${pct.toFixed(2)}% is below the ${floor}% floor`);
    process.exit(1);
}
process.exit(suite.status === 0 ? 0 : suite.status);
