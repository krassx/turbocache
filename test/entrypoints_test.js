'use strict';
// The package entry points, exercised as a consumer reaches them.
//
// Coverage found these at 0%: every other test requires `../src/turbokv`
// directly, so `index.js`, `index.mjs` and the `exports` map that routes to them
// were never loaded by the suite. That is the surface consumers actually touch,
// and it is where the CJS/ESM split can break without any source file changing --
// a wrong `exports` condition, a re-export dropped from index.mjs, or a default
// export that is the module namespace instead of the class.
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const ROOT = path.join(__dirname, '..');
const EXPECTED = ['TurboKV', 'Cache', 'MSG'];

(async () => {
    // --- CommonJS: require('turbokv')
    const cjs = require(path.join(ROOT, 'index.js'));
    ok(typeof cjs.TurboKV === 'function', 'cjs: TurboKV is exported');
    ok(cjs.Cache === cjs.TurboKV, 'cjs: Cache is the same class as TurboKV');
    ok(typeof cjs.MSG === 'string', 'cjs: MSG is exported');
    ok(typeof cjs.TurboKV.createPrimary === 'function',
       'cjs: the class carries its statics');
    ok(cjs.TurboKV.native === undefined,
       'cjs: the addon is NOT reachable from the public surface');

    // --- ESM: import 'turbokv'
    const esm = await import(pathToFileURL(path.join(ROOT, 'index.mjs')).href);
    for (const name of EXPECTED) {
        ok(esm[name] !== undefined, `esm: ${name} is a named export`);
    }
    ok(esm.default === esm.TurboKV,
       'esm: the DEFAULT export is the class, not the module namespace');
    ok(esm.TurboKV === cjs.TurboKV,
       'esm and cjs resolve to the same class (one implementation, two wrappers)');
    ok(esm.Cache === esm.TurboKV, 'esm: Cache aliases TurboKV');

    // --- the two entry points must agree on their surface
    const cjsNames = Object.keys(cjs).sort();
    const esmNames = Object.keys(esm).filter(n => n !== 'default').sort();
    ok(JSON.stringify(cjsNames) === JSON.stringify(esmNames),
       `both entry points export the same names (cjs=${cjsNames} esm=${esmNames})`);
    ok(JSON.stringify(cjsNames) === JSON.stringify([...EXPECTED].sort()),
       `the public surface is exactly ${[...EXPECTED].sort().join(', ')}`);

    // --- and the class actually works when reached this way
    const c = cjs.TurboKV.createPrimary('/tcep' + process.pid, 8 << 20, 1 << 13,
                                           { storage: 'direct' });
    c.set('k', { a: 1 });
    const got = c.get('k');
    ok(got != null && got.a === 1, 'a cache created through the entry point works');
    require(path.join(ROOT, 'src', 'native')).destroy();

    console.log(fail ? `  ${fail} FAILURES` : '  all passed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
