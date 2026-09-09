const { TurboCache } = require('./turbocache');
const native = require('./build/Release/l2.node');
const c = TurboCache.createPrimary('/tctf' + process.pid, 32 << 20, 1 << 16,
                                   { values: 'bytes', l1MaxBytes: 32 * 1024 });
const cases = [['string', 'hello'], ['number', 42], ['float', 1.5], ['boolean', true], ['null', null]];
console.log('  value    typeof in   L1 hit gives      reaches L2?   after L1 eviction');
for (const [label, v] of cases) {
    c.set('k_' + label, v);
    const fromL1 = c.get('k_' + label);
    const inL2 = native.get('k_' + label);          // read the arena directly
    // evict L1 without touching L2 for this key
    for (let i = 0; i < 300; i++) c.set('pad' + label + i, 'x'.repeat(200));
    const afterEvict = c.get('k_' + label);
    console.log(`  ${label.padEnd(8)} ${(typeof v).padEnd(11)} ${String(fromL1).padEnd(10)}${(typeof fromL1).padEnd(8)}` +
        `${(inL2 === undefined ? 'NO' : 'yes').padEnd(14)}${afterEvict === undefined ? 'LOST' : String(afterEvict) + ' (' + typeof afterEvict + ')'}`);
}
TurboCache.native().destroy();
