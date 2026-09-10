#!/usr/bin/env node
// Decides whether a TSAN run is acceptable.
//
// Matching the SUMMARY line proved brittle: the SUMMARY names whichever frame
// TSAN picked, and that differs by platform and inlining. macOS reported
// `logDropTail`/`writer`; Linux reported `__tsan_memcpy` (its memcpy
// interceptor) and `logAlloc` (logDropTail inlined into it) for the very same
// race. So classify by the WHOLE stack instead: a report is known only if every
// frame of ours that appears in it belongs to the deliberate seqlock payload
// copy. Any frame outside that set is a regression and fails the run.
const fs = require('fs');

// Judge by ADDRESS, not by function name. Names failed twice: the SUMMARY frame
// differs by platform, and an injected unrelated race was waved through because
// the racing helper had been inlined into `reader`, which was on the allowlist.
// The deliberate race is confined to the arena's data region, so any racing
// address outside that range is by definition something else.

const text = fs.readFileSync(process.argv[2], 'utf8');
const range = text.match(/ARENA_DATA (0x[0-9a-f]+) (0x[0-9a-f]+)/);
if (!range) { console.log('    FAIL: harness did not report the arena range'); process.exit(1); }
const lo = BigInt(range[1]), hi = BigInt(range[2]);
const blocks = text.split(/WARNING: ThreadSanitizer/).slice(1);
const outside = [];
for (const b of blocks) {
    // Only the ACCESS stacks matter. A report also carries "Thread TN (...)
    // created by main thread at:" sections, whose frames describe where threads
    // were spawned, not where the race happened - counting those flagged `main`
    // on every report.
    const body = b.split(/SUMMARY: ThreadSanitizer/)[0]
                  .split(/^\s+Thread T\d+ .*created by/m)[0];
    for (const line of body.split('\n')) {
        const m = line.match(/(?:read|write) of size \d+ at (0x[0-9a-f]+)/i);
        if (!m) continue;
        const addr = BigInt(m[1]);
        if (addr < lo || addr >= hi) {
            const fn = (body.match(/#0 ([A-Za-z_][A-Za-z0-9_:<>~]*)/) || [, '?'])[1];
            outside.push(`${m[1]} in ${fn}`);
        }
    }
}
const corrupt = (text.match(/CORRUPT=(\d+)/) || [, '?'])[1];
console.log(`    reports=${blocks.length} corrupt=${corrupt}` +
            (outside.length ? `  OUTSIDE THE ARENA: ${outside.slice(0, 3).join('; ')}`
                            : '  (every racing address is inside the arena payload)'));
if (corrupt !== '0') { console.log('    FAIL: torn or wrong values observed'); process.exit(1); }
if (outside.length) { console.log('    FAIL: race outside the deliberate seqlock payload copy'); process.exit(1); }
