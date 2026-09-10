function heap() { global.gc(); global.gc(); global.gc(); return process.memoryUsage().heapUsed; }
const MB = 2 ** 20;

// Buffer -> string produces a fresh FLAT SeqString, not a cons or a slice.
function flatAscii(len, seed) {
    const b = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) b[i] = 97 + ((i + seed) % 26);
    return b.toString('latin1');
}
function flatTwoByte(len, seed) {
    let s = '';
    const b = Buffer.allocUnsafe(len * 2);
    for (let i = 0; i < len; i++) b.writeUInt16LE(0x4e00 + ((i + seed) % 1000), i * 2);
    return b.toString('utf16le');
}

function measure(label, N, len, make, pred) {
    const arr = new Array(N);
    const base = heap();
    for (let i = 0; i < N; i++) arr[i] = make(len, i);
    const truth = (heap() - base) / N;
    if (!arr[0]) throw 0;
    console.log(`  ${label.padEnd(10)} ${String(len).padStart(6)} ${truth.toFixed(0).padStart(10)}B ` +
        `${String(pred).padStart(10)}B ${(((pred - truth) / truth) * 100).toFixed(0).padStart(6)}%`);
}

console.log('  A. flat one-byte strings: predicted = 16 + len, 8-aligned\n');
console.log('     kind        len      truth   predicted    err');
for (const len of [32, 128, 1024, 8192]) measure('ascii', 20000, len, flatAscii, Math.ceil((16 + len) / 8) * 8);

console.log('\n  B. flat two-byte strings: predicted = 16 + 2*len\n');
console.log('     kind        len      truth   predicted    err');
for (const len of [128, 1024]) measure('utf16', 20000, len, flatTwoByte, Math.ceil((16 + 2 * len) / 8) * 8);

console.log('\n  C. do substrings retain their parent once the parent is dropped?\n');
function sliceTest(label, transform) {
    let parent = flatAscii(4 * MB, 7);
    const N = 200;
    const slices = new Array(N);
    for (let i = 0; i < N; i++) slices[i] = transform(parent.substring(i * 100, i * 100 + 100));
    parent = null;                     // the only other reference is gone
    const after = heap();              // forced GC: anything left is retained BY the slices
    if (!slices[0]) throw 0;
    const perSlice = 112;
    console.log(`  ${label.padEnd(26)} retained ${(after / MB).toFixed(2)}MB total,` +
        ` expected ~${(N * perSlice / 1024).toFixed(0)}KB of slices`);
    return after;
}
const baseline = heap();
console.log(`     baseline heap: ${(baseline / MB).toFixed(2)}MB`);
sliceTest('substring kept as-is', s => s);
sliceTest('copied via Buffer', s => Buffer.from(s, 'latin1').toString('latin1'));
