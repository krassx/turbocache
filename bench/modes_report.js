'use strict';
// json-fastpath-lint: allow
// Scorecard for the three storage modes: validity, safety, consistency, performance.
const { TurboCache } = require('../prototype/turbocache');
const MODES = ['primitives', 'direct', 'safe'];
let seq = 0;
const mk = (storage, opts = {}) => TurboCache.createPrimary(
    '/tcrep' + process.pid + '_' + (seq++), 64 << 20, 1 << 17,
    { storage, l1MaxBytes: 256 * 1024, ...opts });
// push a key out of L1 without disturbing L2
const evictL1 = (c, prim) => { const pad = prim ? 'y'.repeat(400) : { pad: 'y'.repeat(400) };
    for (let i = 0; i < 900; i++) c.set('__pad' + i, pad); };

// deep equality that understands the types we care about, with a cycle guard
function deepEq(a, b, seen = new Map()) {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== 'object') return false;
    if (seen.get(a) === b) return true;
    seen.set(a, b);
    if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof RegExp) return b instanceof RegExp && String(a) === String(b);
    if (a instanceof Map) { if (!(b instanceof Map) || a.size !== b.size) return false;
        for (const [k, v] of a) if (!b.has(k) || !deepEq(v, b.get(k), seen)) return false; return true; }
    if (a instanceof Set) { if (!(b instanceof Set) || a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false; return true; }
    if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && a.length === b.length &&
        a.every((x, i) => x === b[i]);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEq(a[k], b[k], seen));
}

// ---------------------------------------------------------------- VALIDITY
const TYPES = {
    string: 'hello', asciiLong: 'x'.repeat(5000), unicode: 'héllo 中文 🚀',
    number: 42, float: -1.5, negZero: -0, nan: NaN, infinity: Infinity,
    boolean: true, null: null, bigint: 2n ** 100n,
    date: new Date('2026-09-08T10:00:00Z'), array: [1, 'a', { b: 2 }],
    object: { a: 1, nested: { b: [2, 3] } }, map: new Map([['k', 1]]),
    set: new Set([1, 2]), uint8: new Uint8Array([1, 2, 3]), regexp: /ab+c/gi
};
function validity() {
    console.log('\n=== VALIDITY — does what comes out match what went in? ===');
    console.log('  (set, force out of L1, read back through the shared arena)\n');
    const res = {};
    for (const mode of MODES) {
        res[mode] = {};
        for (const [name, val] of Object.entries(TYPES)) {
            const c = mk(mode);
            const prim = mode === 'primitives';
            let verdict;
            try {
                if (c.set('t', val) === false) { TurboCache.native().destroy(); res[mode][name] = 'rejected'; continue; }
                evictL1(c, prim);
                const got = c.get('t');
                verdict = got === undefined ? 'LOST' : (deepEq(val, got) ? 'exact' : 'CONVERTED');
            } catch (e) { verdict = 'rejected'; }
            TurboCache.native().destroy();
            res[mode][name] = verdict;
        }
    }
    const mark = v => ({ exact: '  exact  ', CONVERTED: ' CONVERTED', LOST: '  LOST   ', rejected: ' rejected' })[v];
    console.log('  type         ' + MODES.map(m => m.padEnd(11)).join(''));
    for (const name of Object.keys(TYPES))
        console.log('  ' + name.padEnd(12) + ' ' + MODES.map(m => mark(res[m][name])).join(' '));
    for (const mode of MODES) {
        const v = Object.values(res[mode]);
        const n = t => v.filter(x => x === t).length;
        console.log(`  ${mode.padEnd(12)} exact ${n('exact')}/${v.length}, converted ${n('CONVERTED')}, rejected ${n('rejected')}, lost ${n('LOST')}`);
    }
    return res;
}
// ------------------------------------------------------------------ SAFETY
// Can a caller corrupt the cache? Each vector reports whether the cached value
// changed, i.e. whether the cache was successfully corrupted.
function safety() {
    console.log('\n=== SAFETY — can a caller corrupt the cache? ===\n');
    const vectors = {
        'mutate object passed to set': (c, prim) => {
            if (prim) return 'n/a';
            const mine = { n: 1, deep: { d: 1 } };
            c.set('s', mine);
            try { mine.n = 999; } catch { return 'throws'; }
            return c.get('s').n === 1 ? 'safe' : 'CORRUPTED';
        },
        'mutate get() result': (c, prim) => {
            if (prim) return 'n/a';
            c.set('s', { n: 1, deep: { d: 1 } });
            const g = c.get('s');
            try { g.n = 999; } catch { return 'throws'; }
            return c.get('s').n === 1 ? 'safe' : 'CORRUPTED';
        },
        'mutate NESTED object in result': (c, prim) => {
            if (prim) return 'n/a';
            c.set('s', { n: 1, deep: { d: 1 } });
            const g = c.get('s');
            try { g.deep.d = 999; } catch { return 'throws'; }
            return c.get('s').deep.d === 1 ? 'safe' : 'CORRUPTED';
        },
        'write into typed array in result': (c, prim) => {
            if (prim) return 'n/a';
            if (c.set('s', { b: new Uint8Array([1, 2]) }) === false) return 'rejected';
            const g = c.get('s');
            if (!(g.b instanceof Uint8Array)) return 'n/a (converted)';
            try { g.b[0] = 99; } catch { return 'throws'; }
            return c.get('s').b[0] === 1 ? 'safe' : 'CORRUPTED';
        },
        'value survives L1 eviction unchanged': (c, prim) => {
            const v = prim ? 'orig' : { n: 1 };
            c.set('s', v);
            const before = prim ? c.get('s') : c.get('s').n;
            evictL1(c, prim);
            const after = prim ? c.get('s') : c.get('s').n;
            return before === after ? 'safe' : 'REVERTED';
        }
    };
    console.log('  vector                                ' + MODES.map(m => m.padEnd(18)).join(''));
    for (const [name, fn] of Object.entries(vectors)) {
        const row = MODES.map(m => { const c = mk(m); let r;
            try { r = fn(c, m === 'primitives'); } catch (e) { r = 'ERR ' + e.constructor.name; }
            TurboCache.native().destroy(); return r.padEnd(18); });
        console.log('  ' + name.padEnd(38) + row.join(''));
    }
}

// ------------------------------------------------------------- CONSISTENCY
// Does L1 agree with L2? Run a randomised stream, then compare every key as
// served from L1 against the same key served from the arena after eviction.
function consistency() {
    console.log('\n=== CONSISTENCY — does L1 agree with L2? ===\n');
    const NKEYS = 300, OPS = 6000;
    for (const mode of MODES) {
        // reseed per mode so every mode sees the IDENTICAL operation stream
        let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
        const prim = mode === 'primitives';
        const c = mk(mode, { l1MaxBytes: 128 * 1024 });
        const expect = new Map();
        const val = i => prim ? 'v' + i + ':' + 'x'.repeat(60) : { i, tag: 'v' + i, pad: 'x'.repeat(60) };
        for (let n = 0; n < OPS; n++) {
            const i = (rnd() * NKEYS) | 0, k = 'k' + i;
            if (rnd() < 0.3) { const v = val(i * 1000 + n); c.set(k, v); expect.set(k, v); }
            else c.get(k);
        }
        // phase 1: as currently served (mixture of L1 and L2)
        let mism1 = 0;
        for (const [k, v] of expect) if (!deepEq(v, c.get(k))) mism1++;
        // phase 2: force everything out of L1 so every read comes from the arena
        evictL1(c, prim);
        let mism2 = 0, lost = 0;
        for (const [k, v] of expect) {
            const g = c.get(k);
            if (g === undefined) lost++; else if (!deepEq(v, g)) mism2++;
        }
        const st = c.stats;
        console.log(`  ${mode.padEnd(12)} ${expect.size} live keys | served-now mismatches ${mism1}` +
            ` | from-arena mismatches ${mism2} | evicted-from-arena ${lost}` +
            ` | L1 hits ${st.l1Hits} L2 hits ${st.l2Hits}`);
        TurboCache.native().destroy();
    }
    console.log('  (evicted-from-arena counts keys the arena legitimately dropped, not errors)');
}

// ------------------------------------------- CROSS-PROCESS CONSISTENCY
// The point of L2: a worker attached read-only must see exactly what the
// primary wrote, decoded through the same mode.
function crossProcess() {
    const { execFileSync } = require('child_process');
    console.log('\n=== CROSS-PROCESS CONSISTENCY — does a worker see what the primary wrote? ===\n');
    for (const mode of MODES) {
        const name = '/tcxp' + process.pid + '_' + mode.length;
        const out = execFileSync(process.execPath, [__filename, 'child', name, mode], { encoding: 'utf8' });
        console.log('  ' + mode.padEnd(12) + out.trim());
    }
}

if (process.argv[2] === 'child') {
    // parent half: create the arena, write, then fork a reader
    const [, , , arena, mode] = process.argv;
    const prim = mode === 'primitives';
    if (!process.env.TC_CHILD) {
        const c = TurboCache.createPrimary(arena, 32 << 20, 1 << 16, { storage: mode, l1MaxBytes: 64 * 1024 });
        const N = 200;
        for (let i = 0; i < N; i++) c.set('k' + i, prim ? 'val' + i : { i, tag: 'val' + i });
        const { execFileSync } = require('child_process');
        const r = execFileSync(process.execPath, [__filename, 'child', arena, mode],
                               { encoding: 'utf8', env: { ...process.env, TC_CHILD: '1' } });
        TurboCache.native().destroy();
        process.stdout.write(r);
    } else {
        const c = TurboCache.attachWorker(arena, 1, { storage: mode, l1MaxBytes: 64 * 1024 });
        let ok = 0, bad = 0, missing = 0;
        for (let i = 0; i < 200; i++) {
            const g = c.get('k' + i);
            if (g === undefined) missing++;
            else if (deepEq(prim ? 'val' + i : { i, tag: 'val' + i }, g)) ok++;
            else bad++;
        }
        process.stdout.write(`worker read ${ok}/200 correct, ${bad} wrong, ${missing} missing`);
    }
    process.exit(0);
}

// ------------------------------------------------------------- PERFORMANCE
async function performance() {
    const { run, buildPlan } = require('./workload');
    console.log('\n=== PERFORMANCE — 200k ops, ns/op sampled 1 in 256 ===\n');
    const shapes = [
        ['reads dominate, fits L1', 1000, 0.01],
        ['mixed 90/10, exceeds L1', 60000, 0.10],
        ['write-heavy 50/50',       60000, 0.50]
    ];
    console.log('  workload                   ' + MODES.map(m => m.padEnd(20)).join(''));
    for (const [label, nkeys, writeRatio] of shapes) {
        const plan = buildPlan({ ops: 200000, nkeys, seed: 3, writeRatio });
        const cells = [];
        for (const mode of MODES) {
            const prim = mode === 'primitives';
            const c = TurboCache.createPrimary('/tcperf' + process.pid + '_' + (seq++), 256 << 20, 1 << 20,
                                               { storage: mode, l1MaxBytes: 2 << 20 });
            // primitives cannot take objects, so the app encodes - counted against it
            const p = prim ? { ...plan, vals: plan.vals.map(v => JSON.stringify(v)) } : plan;
            const ad = prim
                ? { sync: true, get: k => { const s = c.get(k); return s === undefined ? undefined : JSON.parse(s); },
                    set: (k, v) => c.set(k, v) }
                : { sync: true, get: k => c.get(k), set: (k, v) => c.set(k, v) };
            const r = await run(ad, p, 256, 0);
            cells.push(`${(r.opsPerSec/1000).toFixed(0)}k/${r.p50}ns`.padEnd(20));
            TurboCache.native().destroy();
        }
        console.log('  ' + label.padEnd(27) + cells.join(''));
    }
}

module.exports = { mk, evictL1, deepEq, MODES, validity, safety, consistency, crossProcess, performance };
if (require.main === module) (async () => { validity(); safety(); consistency(); crossProcess(); await performance(); })();
