// Standalone repro: cost of v8.getHeapStatistics() as the heap grows.
//
//   node repro/heapstats-cost.mjs
//   bun  repro/heapstats-cost.mjs
//
// No dependencies, no native addons, no framework. process.memoryUsage() is
// measured alongside as a control, so a slow result cannot be blamed on general
// interop overhead. Each cost is time-boxed rather than fixed-count, because a
// fixed count is unrunnable if one call turns out to cost milliseconds.
import v8 from 'node:v8';

const rt = typeof Bun !== 'undefined' ? `bun ${Bun.version}`
         : typeof Deno !== 'undefined' ? `deno ${Deno.version.deno}`
         : `node ${process.versions.node}`;
const MB = 1048576;
const BUDGET_MS = 400;      // per measurement
const MAX_CALLS = 200000;

// Time-boxed: return ns/call, and how many calls actually ran.
function cost(fn) {
    fn(); fn(); fn();                                  // warm
    const t0 = Date.now();
    let n = 0;
    while (n < MAX_CALLS) {
        fn(); n++;
        if ((n & 63) === 0 && Date.now() - t0 >= BUDGET_MS) break;
    }
    const ms = Date.now() - t0;
    return { ns: (ms * 1e6) / n, n, ms };
}

const live = [];
function growTo(targetMB) {
    // Retained objects, so the heap genuinely holds this much. Bounded: a
    // runtime whose reported used_heap_size does not follow allocation would
    // otherwise spin here forever, and that divergence is itself worth seeing.
    const cap = 4_000_000;
    while (v8.getHeapStatistics().used_heap_size < targetMB * MB && live.length < cap) {
        for (let i = 0; i < 20000; i++) live.push({ i, s: 'x'.repeat(100), a: [i, i + 1] });
    }
}

console.log(`\nruntime: ${rt}   platform: ${process.platform}/${process.arch}\n`);
console.log('  live heap   v8.getHeapStatistics()      process.memoryUsage()     ratio');
console.log('  ---------   ------------------------    ---------------------     -----');
for (const targetMB of [5, 25, 50, 100, 200]) {
    growTo(targetMB);
    const usedMB = v8.getHeapStatistics().used_heap_size / MB;
    if (usedMB < targetMB * 0.5) console.log(`  (note: asked for ${targetMB}MB, runtime reports ${usedMB.toFixed(0)}MB after ${live.length.toLocaleString()} objects)`);
    const a = cost(() => v8.getHeapStatistics().used_heap_size);
    const b = cost(() => process.memoryUsage().heapUsed);
    const fmt = (c) => `${c.ns < 10000 ? c.ns.toFixed(0) + ' ns' : (c.ns / 1e6).toFixed(2) + ' ms'}`.padStart(9)
        + ` (${String(c.n).padStart(6)} calls)`;
    console.log(`  ${usedMB.toFixed(0).padStart(5)} MB   ${fmt(a)}    ${fmt(b)}     ${(a.ns / b.ns).toFixed(1)}x`);
}
console.log(`\n  live objects retained: ${live.length.toLocaleString()}`);

// --- what is the call doing? ------------------------------------------------
// Cost proportional to heap size suggests a walk or a collection rather than
// reading counters. These two checks distinguish them.
console.log('\n  diagnostics');

// 1. Does the call COLLECT? Make garbage, then see whether calling it reclaims.
{
    for (let i = 0; i < 400000; i++) { const junk = { i, s: 'g'.repeat(80) }; if (junk.i < 0) live.push(junk); }
    const before = v8.getHeapStatistics().used_heap_size / MB;
    const t0 = Date.now();
    v8.getHeapStatistics();
    const callMs = Date.now() - t0;
    const after = v8.getHeapStatistics().used_heap_size / MB;
    console.log(`    heap before a call ${before.toFixed(1)}MB -> after ${after.toFixed(1)}MB` +
                ` (one call took ${callMs}ms) -> ${after < before * 0.9 ? 'the call APPEARS TO COLLECT' : 'no obvious collection'}`);
}

// 2. How does it compare with an explicit full GC on the same runtime?
{
    const forceGc = typeof Bun !== 'undefined' ? () => Bun.gc(true)
                  : typeof globalThis.gc === 'function' ? () => globalThis.gc()
                  : null;
    if (forceGc) {
        const g = cost(forceGc);
        const h = cost(() => v8.getHeapStatistics());
        console.log(`    explicit full GC ${(g.ns / 1e6).toFixed(2)} ms/call vs getHeapStatistics ` +
                    `${(h.ns / 1e6).toFixed(2)} ms/call -> ratio ${(h.ns / g.ns).toFixed(2)}x`);
    } else {
        console.log('    explicit full GC unavailable (node needs --expose-gc); skipped');
    }
}
console.log('');
