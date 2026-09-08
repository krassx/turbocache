const native = require('./build/Release/l2.node');
function heap() { global.gc(); global.gc(); global.gc(); return process.memoryUsage().heapUsed; }
const MB = 2 ** 20;
// Built by join, not Buffer.toString: Node makes EXTERNAL strings above ~64KB
// from buffers, which live off the JS heap and are invisible to heapUsed.
function heapString(len) {
    const chunk = 'abcdefgh';
    const parts = new Array(Math.ceil(len / 8)).fill(chunk);
    return parts.join('').slice(0, len);
}
globalThis.KEEP = null;
function trial(label, make) {
    const b0 = heap();
    let parent = heapString(8 * MB);
    globalThis.KEEP = make(parent);
    parent = null;
    const d = heap() - b0;
    const probe = globalThis.KEEP.charCodeAt(globalThis.KEEP.length - 1);
    console.log(`  ${label.padEnd(34)} ${(d / MB).toFixed(2).padStart(6)}MB  (probe ${probe})`);
    globalThis.KEEP = null;
    return d;
}
console.log('  8MB heap-resident parent; keep one derived string; drop the parent\n');
const c = trial('whole 8MB parent (control)', p => p);
const a = trial('1MB substring kept as-is', p => p.substring(0, 1 * MB));
const b = trial('1MB substring, Buffer round-trip', p => Buffer.from(p.substring(0, 1 * MB), 'latin1').toString('latin1'));
const f = trial('1MB substring, native.flatten', p => native.flatten(p.substring(0, 1 * MB)));
console.log(`\n  harness control sees 8MB: ${c > 7 * MB ? 'YES' : 'NO - stop, unreliable'}`);
if (c > 7 * MB) {
    console.log(`  substring as-is : ${(a/MB).toFixed(2)}MB -> ${a > 4*MB ? 'RETAINS THE WHOLE PARENT' : 'only its own bytes'}`);
    console.log(`  Buffer copy     : ${(b/MB).toFixed(2)}MB -> ${b > 4*MB ? 'RETAINS THE WHOLE PARENT' : 'only its own bytes'}`);
}
