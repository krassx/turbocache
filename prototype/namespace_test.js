// Does a quota actually stop a hot namespace from evicting a cold one?
const { TurboCache } = require('./turbocache');
const native = require('./build/Release/l2.node');
let seq = 0;
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fails++; };

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
// A quota must protect a cold namespace even when the INDEX, not the data
// region, is the binding constraint. It used to protect nothing there: the
// index-pressure eviction loop passed a null second-chance budget and dropped
// unconditionally, so a cold namespace lost every one of its 500 quota-
// protected entries while liveBytes sat at 0.45MB of 32MB. autoSize() gives one
// slot per 512B, so any workload averaging under ~384B is index-bound in
// production and never saw the eviction policy at all.
{
    const A = '/tcnsidx' + process.pid;
    const cold = TurboCache.createPrimary(A, 32 << 20, 1 << 12, {
        storage: 'bytes', namespace: { name: 'cold', quotaBytes: 4 << 20 }, l1MaxBytes: 1 << 16 });
    const Ctor = Object.getPrototypeOf(cold).constructor;
    const hot = new Ctor({ storage: 'bytes', namespace: { name: 'hot' }, l1MaxBytes: 1 << 16 });
    for (let i = 0; i < 500; i++) cold.set('c' + i, 'C'.repeat(100));
    cold.clearLocal();
    for (let i = 0; i < 200000; i++) hot.set('h' + i, 'H'.repeat(100));
    cold.clearLocal();
    let survivors = 0;
    for (let i = 0; i < 500; i++) if (cold.get('c' + i) !== undefined) survivors++;
    const st = TurboCache.namespaceStats().find(x => x.name === 'cold') || {};
    console.log(`  index-bound quota: ${survivors}/500 cold survivors, protected=${st.protected} dropped=${st.dropped}`);
    ok(survivors > 350, 'a quota protects a cold namespace under INDEX pressure, not just data pressure');
    ok(st.dropped < 200, 'protected entries are not counted as protected and then dropped anyway');
    cold.close();
}

// `withQuota > noQuota * 5` is vacuous when noQuota is 0, which it is: 0 > 0 is
// false, so the whole suite hinged on a comparison that could only ever fail by
// accident. Assert the thing that actually matters instead.
ok(noQuota === 0 || withQuota > noQuota * 5,
   `quota beats no-quota (${noQuota} -> ${withQuota} survivors)`);
ok(withQuota > 500, `a quota protects most of the cold set (${withQuota}/1000 survived)`);
console.log(fails ? `\n  ${fails} FAILED` : '\n  all passed');
process.exit(fails ? 1 : 0);
