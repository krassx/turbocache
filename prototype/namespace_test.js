// Does a quota actually stop a hot namespace from evicting a cold one?
const { TurboCache } = require('./turbocache');
const native = require('./build/Release/l2.node');
let seq = 0;

function scenario(label, quotas) {
    // 'cold' writes a small working set once; 'hot' then hammers the arena.
    const name = '/tcnsq' + process.pid + '_' + (seq++);
    const cold = TurboCache.createPrimary(name, 8 << 20, 1 << 16,
        { storage: 'bytes', l1MaxBytes: 16 * 1024,
          namespace: { name: 'cold', quotaBytes: quotas.cold } });
    // second namespace in the SAME process, bound to the arena already created
    const hot = TurboCache.open(
        { storage: 'bytes', l1MaxBytes: 16 * 1024,
          namespace: { name: 'hot', quotaBytes: quotas.hot } });

    const val = 'x'.repeat(500);
    const COLD_KEYS = 1000;
    for (let i = 0; i < COLD_KEYS; i++) cold.set('c' + i, val);
    cold.clearLocal();
    // hot namespace writes ~20x the arena
    for (let i = 0; i < 30000; i++) hot.set('h' + i, val);
    cold.clearLocal();
    let survived = 0;
    for (let i = 0; i < COLD_KEYS; i++) if (cold.get('c' + i) !== undefined) survived++;
    const st = TurboCache.namespaceStats();
    const row = n => st.find(x => x.name === n) || {};
    console.log(`  ${label.padEnd(34)} cold survivors ${String(survived).padStart(5)}/${COLD_KEYS}` +
        `   cold bytes ${((row('cold').bytes || 0) / 1024).toFixed(0).padStart(5)}KB` +
        `   hot bytes ${((row('hot').bytes || 0) / 1024).toFixed(0).padStart(5)}KB`);
    TurboCache.native().destroy();
    return survived;
}

console.log('  8MB arena (~4MB data). cold writes 1000x500B once, hot then writes 30000x500B.\n');
const noQuota = scenario('no quotas (current behaviour)', { cold: 0, hot: 0 });
const withQuota = scenario('cold 1MB / hot 2MB quota', { cold: 1 << 20, hot: 2 << 20 });
console.log(`\n  ${withQuota > noQuota * 5 ? 'PASS' : 'FAIL'}: quota protected the cold namespace ` +
    `(${noQuota} -> ${withQuota} survivors)`);
process.exit(withQuota > noQuota * 5 ? 0 : 1);
