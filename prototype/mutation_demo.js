'use strict';
const { TurboCache } = require('./turbocache');
const JSONC = { encode: JSON.stringify, decode: JSON.parse };
const L = s => console.log('    ' + s);
let n = 0;
const mk = o => TurboCache.createPrimary('/tcm' + process.pid + '_' + (n++), 32 << 20, 1 << 16,
                                         Object.assign({ l1MaxBytes: 64 * 1024 }, o));
const evict = (c, prim) => { const v = { pad: 'x'.repeat(300) };
    for (let i = 0; i < 400; i++) c.set('f' + i, prim ? JSON.stringify(v) : v); };

function scenario(title, opts, prim) {
    console.log(`\n=== ${title} ===`);
    const c = mk(opts);
    const put = v => c.set('acct', prim ? JSON.stringify(v) : v);
    const got = () => prim ? JSON.parse(c.get('acct')) : c.get('acct');

    // (a) caller mutates the object it passed to set()
    const mine = { id: 'u1', role: 'viewer' };
    put(mine);
    try { mine.role = 'admin'; } catch (e) { L(`set-side mutation THREW ${e.constructor.name}`); }
    L(`after caller mutates its OWN object : role = '${got().role}'`);

    // (b) caller mutates what get() returned
    const fromCache = got();
    try { fromCache.role = 'root'; } catch (e) { L(`get-side mutation THREW ${e.constructor.name}`); }
    L(`after caller mutates get() result   : role = '${got().role}'`);

    // (c) does it survive an L1 eviction, i.e. does L1 agree with L2?
    evict(c, prim);
    L(`after L1 eviction (reads from L2)   : role = '${got().role}'`);
    TurboCache.native().destroy();
}

scenario('codec, isolate:false  (adopts the caller object)', { codec: JSONC, isolate: false });
scenario('codec, isolate:true   (default now)', { codec: JSONC });
scenario('codec, isolate + freeze', { codec: JSONC, freeze: true });
scenario('primitives  (default mode; app parses, like the bugsee design)', { values: 'primitives' }, true);
console.log('\n  "viewer" everywhere = the cache was never corrupted.');
