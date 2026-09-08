'use strict';
// Identical shape and length; the only difference is whether ONE character
// in the payload is non-ASCII. Does that cost the stringify fast path?
function mk(n, marker) {
    const items = [];
    for (let i = 0; i < n; i++) items.push({ k: 'key' + i, v: i, s: 'value' + i + marker });
    return { id: 'doc' + marker, ts: 1757000000000, items };
}
const ASCII = mk(40, 'x');
const ONE_NON_ASCII = mk(40, 'x'); ONE_NON_ASCII.items[0].s += 'é';   // one accented char
const ALL_NON_ASCII = mk(40, '中');

const bench = (fn, n = 50000) => { for (let i = 0; i < 3000; i++) fn();
    const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn();
    return Number(process.hrtime.bigint() - t) / n; };

console.log(`node ${process.version}`);
const a = bench(() => JSON.stringify(ASCII));
const b = bench(() => JSON.stringify(ONE_NON_ASCII));
const c = bench(() => JSON.stringify(ALL_NON_ASCII));
console.log(`  stringify, pure ASCII            ${a.toFixed(0).padStart(6)}ns  (${JSON.stringify(ASCII).length}B)`);
console.log(`  stringify, ONE non-ASCII char    ${b.toFixed(0).padStart(6)}ns  ${(b/a).toFixed(2)}x`);
console.log(`  stringify, all non-ASCII         ${c.toFixed(0).padStart(6)}ns  ${(c/a).toFixed(2)}x`);

const sa = JSON.stringify(ASCII), sb = JSON.stringify(ONE_NON_ASCII), sc = JSON.stringify(ALL_NON_ASCII);
const pa = bench(() => JSON.parse(sa)), pb = bench(() => JSON.parse(sb)), pc = bench(() => JSON.parse(sc));
console.log(`  parse,     pure ASCII            ${pa.toFixed(0).padStart(6)}ns`);
console.log(`  parse,     ONE non-ASCII char    ${pb.toFixed(0).padStart(6)}ns  ${(pb/pa).toFixed(2)}x`);
console.log(`  parse,     all non-ASCII         ${pc.toFixed(0).padStart(6)}ns  ${(pc/pa).toFixed(2)}x`);
