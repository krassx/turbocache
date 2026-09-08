'use strict';
// json-fastpath-lint: allow - measures round-trip variants deliberately.
// How should L1 hand back a value the caller may mutate?
function mk(n) {
    const items = [];
    for (let i = 0; i < n; i++) items.push({ k: 'key' + i, v: i, s: 'value' + i });
    return { id: 'doc', ts: 1757000000000, items };
}
const bench = (fn, n = 30000) => { for (let i = 0; i < 3000; i++) fn();
    const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn();
    return Number(process.hrtime.bigint() - t) / n; };

console.log(`node ${process.version}`);
console.log('  items   bytes    freeze  structuredClone   JSON.parse(str)  parse(stringify)');
for (const n of [5, 40, 200]) {
    const obj = mk(n);
    const str = JSON.stringify(obj);
    const f = bench(() => obj);                             // shared frozen: nothing per get
    const sc = bench(() => structuredClone(obj));
    const jp = bench(() => JSON.parse(str));                // needs the string kept in L1 too
    const rt = bench(() => JSON.parse(JSON.stringify(obj)));
    console.log(`  ${String(n).padStart(5)} ${String(str.length).padStart(7)}` +
        ` ${f.toFixed(0).padStart(9)}ns ${sc.toFixed(0).padStart(14)}ns ${jp.toFixed(0).padStart(16)}ns ${rt.toFixed(0).padStart(16)}ns`);
}

console.log('\n  what each preserves:');
const rich = { d: new Date(0), m: new Map([['a', 1]]), s: new Set([1]), u: undefined, n: NaN, big: 1n, buf: new Uint8Array([1,2]) };
rich.self = rich;                                            // cycle
const probe = (label, fn) => {
    try { const r = fn();
        console.log(`    ${label.padEnd(18)} Date:${r.d instanceof Date ? 'y' : 'n'}` +
            ` Map:${r.m instanceof Map ? 'y' : 'n'} Set:${r.s instanceof Set ? 'y' : 'n'}` +
            ` NaN:${Number.isNaN(r.n) ? 'y' : 'n'} BigInt:${typeof r.big === 'bigint' ? 'y' : 'n'}` +
            ` TypedArray:${r.buf instanceof Uint8Array ? 'y' : 'n'} cycle:${r.self === r ? 'y' : 'n'}`);
    } catch (e) { console.log(`    ${label.padEnd(18)} THROWS ${e.constructor.name}`); }
};
probe('structuredClone', () => structuredClone(rich));
probe('JSON round-trip', () => JSON.parse(JSON.stringify(rich)));
