// Regression tests for every defect the adversarial review found.
const { Cache, TurboCache } = require('./turbocache');
const native = require('./build/Release/l2.node');
let fail = 0, n = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fail++; } };
const mk = o => TurboCache.createPrimary('/tcrr' + process.pid + '_' + (n++), 8 << 20, 1 << 16,
    { storage: 'bytes', l1MaxBytes: 32 * 1024, ...o });

// 1. long / non-latin1 keys must never collide or truncate
{
    const c = mk({});
    const A = 'K'.repeat(511) + 'A', B = 'K'.repeat(511) + 'B';
    c.set(A, 'value-A'); c.set(B, 'value-B'); c.clearLocal();
    ok(c.get(A) === 'value-A' && c.get(B) === 'value-B', '511+ byte keys stay distinct');
    ok(c.get('K'.repeat(511) + 'ZZZ') === undefined, 'never-set long key is a miss');
    c.set('ā', 'a-macron'); c.set('ȁ', 'a-double-grave'); c.clearLocal();
    ok(c.get('ā') === 'a-macron' && c.get('ȁ') === 'a-double-grave', 'non-latin1 keys distinct');
    c.set('中', 'cjk'); c.clearLocal();
    ok(c.get('-') === undefined, 'CJK key does not alias an ASCII key');
    ok(c.set('x'.repeat(2000), 'v') === false, 'over-long key rejected, not truncated');
    TurboCache.native().destroy();
}
// 2. index saturation must not brick the arena
{
    const c = mk({});
    const val = 'v'.repeat(200);
    for (let i = 0; i < 60000; i++) c.set('hot' + (i % 3), val);
    for (let i = 0; i < 40; i++) c.set('new' + i, val);
    let sets = 0; for (let i = 0; i < 50; i++) if (c.set('fresh' + i, val)) sets++;
    c.clearLocal();
    let readable = 0; for (let i = 0; i < 50; i++) if (c.get('fresh' + i) !== undefined) readable++;
    const s = native.stats();
    ok(sets === 50 && readable === 50, `arena still usable after churn (sets=${sets} readable=${readable})`);
    ok(s.logTail <= s.logHead, 'tail never overshoots head');
    TurboCache.native().destroy();
}
// 3. TTL must survive an L1 refill from L2
{
    const c = mk({});
    c.set('t', 'v', { ttlMs: 50 });
    let u = Date.now() + 120; while (Date.now() < u);
    ok(c.get('t') === undefined && c.has('t') === false, 'TTL enforced after L1 refill from L2');
    TurboCache.native().destroy();
}
// 4/5. the primary's L1 must follow applied worker batches
{
    const c = mk({});
    c.set('k', 'from-primary');
    TurboCache.applyBatch({ t: 'tc', id: 1, b: ['s', 'k', 'from-worker', 0, 0] });
    ok(c.get('k') === 'from-worker', 'primary L1 sees a worker set');
    TurboCache.applyBatch({ t: 'tc', id: 1, b: ['d', 'k', null, 0, 0] });
    ok(c.get('k') === undefined, 'primary L1 sees a worker delete');
    TurboCache.native().destroy();
}
// 8. a failed set must not destroy the previous value
{
    const c = mk({});
    c.set('keep', 'original');
    ok(c.set('keep', 'y'.repeat(200 * 1024 * 1024)) === false, 'oversized value rejected');
    ok(c.get('keep') === 'original', 'failed set left the previous value intact');
    TurboCache.native().destroy();
}
// 10. no crash before an arena exists or after close
{
    ok(TurboCache.namespaceStats() === undefined, 'namespaceStats before an arena does not crash');
    const c = mk({}); c.close();
    ok(native.get('anything') === undefined, 'native get after destroy does not crash');
}
// sev3: ttl clamp, namespace name length
{
    const c = mk({});
    c.set('big', 'v', { ttlMs: 2147483600 });
    ok(c.has('big') === true, 'huge ttlMs does not overflow into instant expiry');
    let threw = false;
    try { TurboCache.open({ namespace: { name: 'a'.repeat(40) } }); } catch { threw = true; }
    ok(threw, 'over-long namespace name rejected rather than aliased');
    TurboCache.native().destroy();
}
ok(typeof Cache === 'function', 'Cache alias is exported as the docs describe');
// worker and primary must agree on delete() of an absent key
{
    const c = mk({});
    ok(c.delete('never-existed') === false, 'delete of an absent key reports false');
    TurboCache.native().destroy();
}
console.log(fail ? `  ${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
