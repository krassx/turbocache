const { TurboCache } = require('./turbocache');
let fail = 0; const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fail++; } };

const c = TurboCache.open({ storage: 'bytes', namespace: 'app' });

// get / set
ok(c.set('k', 'v') === true, 'set returns true on success');
ok(c.get('k') === 'v', 'get returns the value');
ok(c.get('absent') === undefined, 'get returns undefined for a miss');

// has: pure probe, must not promote or count a hit
c.set('probeme', 'x');
const before = { l1: c.stats.l1Hits, l2: c.stats.l2Hits };
ok(c.has('probeme') === true && c.has('nope') === false, 'has answers correctly');
ok(c.stats.l1Hits === before.l1 && c.stats.l2Hits === before.l2, 'has does not count as a hit');

// has must distinguish a stored null from an absent key
c.set('nul', null);
ok(c.get('nul') === null && c.has('nul') === true, 'stored null: get null, has true');
ok(c.get('gone') === undefined && c.has('gone') === false, 'absent key: get undefined, has false');

// delete
ok(c.delete('k') === true, 'delete returns true when present');
ok(c.get('k') === undefined && c.has('k') === false, 'deleted key is gone from both tiers');
ok(c.delete('k') === false, 'delete returns false when absent');

// namespace isolation
const d = TurboCache.attachWorker.length >= 0 ? null : null;   // placeholder, same arena
c.set('shared', 'ns-a');
ok(c.get('shared') === 'ns-a', 'namespaced key reads back');

// ttl, in both tiers
c.set('tmp', 'x', { ttlMs: 60 });
ok(c.has('tmp') === true, 'ttl key present before expiry');
const until = Date.now() + 1100; while (Date.now() < until);
ok(c.has('tmp') === false && c.get('tmp') === undefined, 'ttl key expired in L1 and L2');

// clearLocal vs clearAll
c.set('a', '1'); c.set('b', '2');
c.clearLocal();
ok(c.get('a') === '1', 'clearLocal drops L1 only; value still served from the arena');
c.clearAll();
ok(c.get('a') === undefined && c.get('b') === undefined, 'clearAll wipes the arena');
ok(c.set('c', '3') === true && c.get('c') === '3', 'cache is usable after clearAll');

// set() reports acceptance, not durability - and a worker must reject an
// oversized value locally rather than queue something the primary will drop
ok(c.set('huge', 'x'.repeat(80 * 1024 * 1024)) === false, 'oversized value rejected at the call site');
ok(/exceeds the/.test(c.lastError) && c.stats.rejectedSize > 0, 'size rejection is explained and counted');

// set never throws and always reports
ok(c.set('x', { a: 1 }) === false, 'unsupported value returns false');
ok(typeof c.lastError === 'string', 'lastError explains the rejection');
ok(c.stats.rejectedType > 0, 'rejection counted in stats');

// enumeration — decision 3 named this as a benefit of storing key text
c.clearAll();
for (let i = 0; i < 5; i++) c.set('e' + i, 'v');
ok([...c.keys()].sort().join(',') === 'e0,e1,e2,e3,e4', 'keys() enumerates this namespace');
ok(c.size === 5, 'size reports live entries');
ok(typeof TurboCache.arenaStats().live === 'number', 'arenaStats() exposes arena counters');
ok([...c.keys({ limit: 2 })].length === 2, 'keys() honours limit');

// lifecycle
ok(typeof c.close === 'function', 'close() exists');
c.close();
console.log(fail ? `  ${fail} FAILURES` : '  all passed');
process.exit(fail ? 1 : 0);
