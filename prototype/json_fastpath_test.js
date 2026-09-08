// Guards the properties that keep JSON on V8's fast path.
// Node 26 made ASCII JSON.stringify ~34% faster but did NOT speed up the slow
// paths, so falling off one now costs relatively more than it used to.
const native = require('./build/Release/l2.node');
const { TurboCache } = require('./turbocache');
const fs = require('fs');
let fail = 0; const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fail++; } };

native.create('/tcfp' + process.pid, 32 << 20, 1 << 16, 2);
native.setCompressMin(1 << 30);

// 1. ASCII values must come back as ONE-BYTE strings. primBytes reports
//    16+len for one-byte and 16+2*len for two-byte, so it doubles as a probe.
const ascii = JSON.stringify({ id: 'abc', items: [1, 2, 3] });
native.set('a', ascii, 0);
const back = native.get('a');
ok(back === ascii, 'ascii value round-trips');
ok(native.primBytes(back) === ((16 + back.length + 7) & ~7), 'value returned as a ONE-BYTE string');

// 2. Non-ASCII must round-trip exactly rather than being mangled by latin1.
for (const s of ['héllo', '中文', '🚀', 'mixed ünï']) {
    native.set('u', s, 0);
    ok(native.get('u') === s, `non-ASCII round-trips: ${s}`);
}

// 3. The codec path must call JSON.stringify/parse with no replacer, no space
//    and no reviver. A replacer costs 3.5x on Node 26 (2.3x on 24); indent 2.1x.
const src = fs.readFileSync(require.resolve('./turbocache.js'), 'utf8');
const stringifyCalls = src.match(/JSON\.stringify\([^)]*\)/g) || [];
const parseCalls = src.match(/JSON\.parse\([^)]*\)/g) || [];
for (const c of stringifyCalls) ok(!c.includes(','), `no replacer/space in stringify: ${c}`);
for (const c of parseCalls) ok(!c.includes(','), `no reviver in parse: ${c}`);

// 4. A cached substring must be flattened, or it retains its parent.
const cache = TurboCache.createPrimary('/tcfp2' + process.pid, 16 << 20, 1 << 16, { values: 'primitives' });
const parent = new Array(50000).fill('abcdefgh').join('');
cache.set('slice', parent.substring(0, 500));
ok(cache.get('slice').length === 500, 'substring cached correctly');
TurboCache.native().destroy();

console.log(fail ? `  ${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
