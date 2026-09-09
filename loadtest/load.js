'use strict';
// Sustained multi-worker load, exercising four distinct paths through the cache.
// Values are self-verifying, so any wrong value is detected the moment it is read.
//
//   flow 1  read L1 only          small hot band that stays L1-resident
//   flow 2  read L1 -> L2         huge cold band: misses L1, hits the arena
//   flow 3  write L1              worker writes its own keys (L1 immediately)
//   flow 4  write L2 -> propagate shared keys: writer -> primary -> ring ->
//                                 OTHER workers drop L1 and refill from L2
const cluster = require('cluster');
const os = require('os');
const { TurboCache } = require('../prototype/turbocache');

const WORKERS  = Number(process.env.WORKERS || 4);
const MINUTES  = Number(process.env.MINUTES || 12);
const HOT      = Number(process.env.HOT || 300);
const COLD     = Number(process.env.COLD || 200000);
const SHARED   = Number(process.env.SHARED || 500);
const L1       = Number(process.env.L1 || 2 * 1024 * 1024);
const L2       = Number(process.env.L2 || 192 * 1024 * 1024);
const MODE     = process.env.MODE || 'bytes';        // bytes | direct | safe
const ARENA    = '/tcload_' + MODE;

// Index slots must scale with the arena: a 1M-slot index is itself ~16MB, which
// a small arena cannot hold, and create() rightly refuses. Size it from L2 at
// roughly one slot per 256 bytes of data, rounded to a power of two.
function slotsFor(bytes) {
    return 1 << Math.max(12, Math.min(22, Math.ceil(Math.log2(Math.max(4096, bytes / 256)))));
}

// Value is fully determined by (key, version), so any reader can self-verify
// without coordinating with the writer.
//
// In `bytes` that is a string. In `direct` (v8.serialize) and `safe` (JSON) it
// is an OBJECT: a codec mode fed nothing but strings would never exercise its
// codec, so the load test would be measuring the wrong thing. The shape stays
// JSON-safe so one generator serves both codecs -- the types JSON degrades
// (Date, Map, Set, BigInt) are checked separately in the fidelity probe below,
// where the two modes are legitimately expected to differ.
function makeVal(key, ver) {
    const len = 64 + (ver * 37) % 700;
    const filler = String.fromCharCode(97 + (ver % 26)).repeat(len);
    if (MODE === 'bytes') return `${key}#${ver}#${filler}`;
    return { k: key, v: ver, n: ver * 1.5, ok: (ver & 1) === 0, tags: [key, ver], body: filler };
}
// Version extraction must follow the value SHAPE: a delimited string in
// `bytes`, a field in the codec modes. The propagation branch used string
// parsing unconditionally, which threw `v.indexOf is not a function` on every
// codec-mode iteration -- 22.7M "errors" that were this harness's fault, not
// the cache's, and which silently disabled propagation accounting for those
// two modes rather than failing loudly.
function versionOf(v) {
    if (MODE !== 'bytes') return v.v;
    const p = v.indexOf('#');
    return Number(v.slice(p + 1, v.indexOf('#', p + 1)));
}
function verify(key, val) {
    if (MODE === 'bytes') {
        if (typeof val !== 'string') return 'not-a-string';
        const p = val.indexOf('#'), q = val.indexOf('#', p + 1);
        if (p < 0 || q < 0) return 'no-delimiters';
        if (val.slice(0, p) !== key) return 'key-mismatch';
        const ver = Number(val.slice(p + 1, q));
        if (!Number.isInteger(ver)) return 'bad-version';
        return val === makeVal(key, ver) ? null : 'payload-mismatch';
    }
    if (val === null || typeof val !== 'object') return 'not-an-object';
    if (val.k !== key) return 'key-mismatch';
    const ver = val.v;
    if (!Number.isInteger(ver)) return 'bad-version';
    const want = makeVal(key, ver);
    if (val.n !== want.n || val.ok !== want.ok || val.body !== want.body) return 'payload-mismatch';
    if (!Array.isArray(val.tags) || val.tags.length !== 2 ||
        val.tags[0] !== key || val.tags[1] !== ver) return 'tags-mismatch';
    return null;
}

if (cluster.isPrimary) {
    console.log(`turbocache load test — ${WORKERS} workers, ${MINUTES} min, storage=${MODE}` +
        `, values are ${MODE === 'bytes' ? 'strings' : 'objects'}`);
    console.log(`  node ${process.version} on ${os.platform()}/${os.arch()}, ${os.cpus().length} cpus`);
    console.log(`  L1 ${(L1/1048576).toFixed(0)}MB/worker, L2 ${(L2/1048576).toFixed(0)}MB shared`);
    console.log(`  bands: hot=${HOT} (L1-resident)  cold=${COLD} (L2)  shared=${SHARED} (cross-worker)\n`);

    const cache = TurboCache.createPrimary(ARENA, L2, slotsFor(L2), { storage: MODE, l1MaxBytes: L1 });
    // Mode semantics, asserted before any load runs. Each mode is SUPPOSED to
    // treat rich types differently -- `safe` silently degrading a Date to a
    // string is correct JSON behaviour, not a bug -- so the check is against a
    // per-mode expectation table, not against equality with the input.
    {
        const EXPECT = {
            bytes:  { string: 'String', number: 'Number', bool: 'Boolean', null: 'Null', bigint: 'BigInt',
                      date: 'REJECTED', array: 'REJECTED', obj: 'REJECTED', map: 'REJECTED', set: 'REJECTED',
                      nan: 'Number', undef: 'REJECTED', typed: 'Uint8Array' },
            direct: { string: 'String', number: 'Number', bool: 'Boolean', null: 'Null', bigint: 'BigInt',
                      date: 'Date', array: 'Array', obj: 'Object', map: 'Map', set: 'Set',
                      nan: 'Number', undef: 'Undefined', typed: 'Uint8Array' },
            safe:   { string: 'String', number: 'Number', bool: 'Boolean', null: 'Null', bigint: 'REJECTED',
                      date: 'String', array: 'Array', obj: 'Object', map: 'Object', set: 'Object',
                      nan: 'Null', undef: 'REJECTED', typed: 'Object' },
        }[MODE];
        const probes = {
            string: 'hi', number: 42, bool: true, null: null, bigint: 10n ** 20n,
            date: new Date(1700000000000), array: [1, 'a', null], obj: { a: 1, b: [2] },
            map: new Map([['a', 1]]), set: new Set([1, 2]), nan: NaN,
            undef: undefined, typed: new Uint8Array([1, 2, 3]),
        };
        let bad = 0;
        for (const [name, v] of Object.entries(probes)) {
            let got;
            try {
                const accepted = cache.set('probe:' + name, v);
                cache.clearLocal();
                got = accepted === false ? 'REJECTED'
                    : Object.prototype.toString.call(cache.get('probe:' + name)).slice(8, -1);
            } catch { got = 'REJECTED'; }
            if (got !== EXPECT[name]) { console.log(`  MODE CHECK FAIL ${name}: got ${got}, expected ${EXPECT[name]}`); bad++; }
        }
        if (bad) { console.log(`  ${MODE}: ${bad} type(s) behaved unexpectedly — aborting`); process.exit(1); }
        console.log(`  ${MODE}: all ${Object.keys(probes).length} type behaviours match the documented matrix`);
        for (const name of Object.keys(probes)) cache.delete('probe:' + name);
        cache.clearLocal();
    }

    process.env.TC_ARENA = ARENA;
    TurboCache.install(cluster);

    // seed the cold band so flow 2 has something to find
    for (let i = 0; i < COLD; i++) cache.set('cold:' + i, makeVal('cold:' + i, 1));
    console.log(`  seeded ${COLD} cold keys, arena live=${TurboCache.arenaStats().live}\n`);

    const agg = {};
    const series = [];                 // { t, workerRssMB, primaryRssMB, heapMB, ops }
    const started = Date.now();
    const pcpu0 = process.cpuUsage();
    for (let i = 0; i < WORKERS; i++) cluster.fork({ WORKER_ID: String(i + 1) });
    cluster.on('message', (w, m) => { if (m && m.t === 'stat') agg[m.id] = m; });
    cluster.on('exit', (w, code, sig) =>
        console.log(`  !! worker ${w.id} exited code=${code} signal=${sig}`));

    const t0 = process.hrtime.bigint();
    const rss0 = process.memoryUsage().rss;
    const report = setInterval(() => {
        const ws = Object.values(agg);
        if (!ws.length) return;
        const sum = k => ws.reduce((a, x) => a + (x[k] || 0), 0);
        const st = TurboCache.arenaStats() || {};
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        const wRss = sum('rss') / ws.length, wHeap = sum('heap') / ws.length;
        const pMem = process.memoryUsage();
        const wallMs = Date.now() - started;
        const workerCpuPct = 100 * (sum('cpuUs') / 1000) / Math.max(1, wallMs) ;
        const primCpuPct = 100 * ((process.cpuUsage(pcpu0).user + process.cpuUsage(pcpu0).system) / 1000) / Math.max(1, wallMs);
        series.push({ t: wallMs, wRss, wHeap, pRss: pMem.rss, ops: sum('ops') });
        console.log(
            `  t=${mins.padStart(5)}m ops=${(sum('ops')/1e6).toFixed(2)}M` +
            ` | L1 ${(100*sum('l1')/Math.max(1,sum('l1')+sum('l2')+sum('miss'))).toFixed(1)}%` +
            ` L2 ${(100*sum('l2')/Math.max(1,sum('l1')+sum('l2')+sum('miss'))).toFixed(1)}%` +
            ` miss ${(100*sum('miss')/Math.max(1,sum('l1')+sum('l2')+sum('miss'))).toFixed(1)}%` +
            ` | prop=${sum('prop')} shed=${(100*sum('shed')/Math.max(1,sum('sent')+sum('shed'))).toFixed(0)}%` +
            ` | live=${st.live} evict=${(st.evictions/1e6).toFixed(1)}M` +
            ` | RSS prim=${(pMem.rss/1048576).toFixed(0)}MB wrk=${(wRss/1048576).toFixed(0)}MB` +
            ` heap=${(wHeap/1048576).toFixed(0)}MB` +
            ` | CPU prim=${primCpuPct.toFixed(0)}% wrk=${workerCpuPct.toFixed(0)}%` +
            (sum('wrong') ? `  *** WRONG VALUES: ${sum('wrong')} ***` : '') +
            (sum('err') ? `  *** ERRORS: ${sum('err')} ***` : ''));
    }, 20000);

    setTimeout(() => {
        clearInterval(report);
        const ws = Object.values(agg);
        const sum = k => ws.reduce((a, x) => a + (x[k] || 0), 0);
        const secs = Number(process.hrtime.bigint() - t0) / 1e9;
        const st = TurboCache.arenaStats() || {};
        console.log(`\n=== RESULT (storage=${MODE}) after ${(secs/60).toFixed(1)} minutes ===`);
        console.log(`  total ops              ${sum('ops').toLocaleString()}  (${(sum('ops')/secs/1000).toFixed(0)}k ops/s aggregate)`);
        console.log(`  flow 1  read L1 only   ${sum('f1').toLocaleString()}`);
        console.log(`  flow 2  read L1->L2    ${sum('f2').toLocaleString()}`);
        console.log(`  flow 3  write own L1   ${sum('f3').toLocaleString()}`);
        console.log(`  flow 4  write shared   ${sum('f4').toLocaleString()}   propagations observed ${sum('prop').toLocaleString()}`);
        console.log(`  tier hits              L1=${sum('l1').toLocaleString()} L2=${sum('l2').toLocaleString()} miss=${sum('miss').toLocaleString()}`);
        console.log(`  arena                  live=${st.live} evictions=${st.evictions.toLocaleString()} liveBytes=${(st.liveBytes/1048576).toFixed(0)}MB`);
        console.log(`  primary RSS            ${(rss0/1048576).toFixed(0)}MB -> ${(process.memoryUsage().rss/1048576).toFixed(0)}MB`);
        console.log(`  worker RSS (avg)       ${(sum('rss')/ws.length/1048576).toFixed(0)}MB`);
        // Leak check. Note worker RSS INCLUDES the shared arena: each worker maps
        // it read-only and every page it touches counts toward its RSS, so RSS
        // climbs until the arena is fully paged in and then plateaus. That is not
        // a leak, so the verdict leans on JS heapUsed, with RSS as a secondary
        // signal measured only after page-in has settled.
        let leaking = false;
        const warm = series.filter(x => x.t > (MINUTES * 60000) / 2);   // second half only
        const half = Math.floor(warm.length / 2);
        const A = warm.slice(0, half), B = warm.slice(half);
        const avg = (a, k) => a.reduce((s2, x) => s2 + x[k], 0) / Math.max(1, a.length);
        // real elapsed minutes between the two window midpoints
        const gapMin = Math.max(0.1, (avg(B, 't') - avg(A, 't')) / 60000);
        // Least-squares over EVERY warm sample, not a difference of two window
        // means. The two-window estimator reported +1.56 MB/min for primary RSS
        // where the regression says +0.84, because GC sawtooth put a 22MB band
        // around a 361MB mean and which samples land in which half dominates the
        // answer. Report the band too: a slope is only meaningful against it.
        const slope = (k) => {
            const ys = warm.map(x => x[k] / 1048576), xs = warm.map(x => x.t / 60000);
            const n = ys.length; if (n < 3) return 0;
            const xm = xs.reduce((a, b) => a + b, 0) / n, ym = ys.reduce((a, b) => a + b, 0) / n;
            let num = 0, den = 0;
            for (let i = 0; i < n; i++) { num += (xs[i] - xm) * (ys[i] - ym); den += (xs[i] - xm) ** 2; }
            return den === 0 ? 0 : num / den;
        };
        const band = (k) => {
            const ys = warm.map(x => x[k] / 1048576);
            return Math.max(...ys) - Math.min(...ys);
        };
        const show = (label, k) => console.log(
            `  ${label.padEnd(22)} ${(avg(A,k)/1048576).toFixed(1)}MB -> ${(avg(B,k)/1048576).toFixed(1)}MB` +
            `  (fit ${slope(k) >= 0 ? '+' : ''}${slope(k).toFixed(2)} MB/min, noise band ${band(k).toFixed(0)}MB` +
            `${Math.abs(slope(k)) * gapMin * 2 < band(k) ? ', slope < noise' : ''})`);
        console.log(`  --- write path to L2 ---`);
        console.log(`  delivered to arena     ${sum('sent').toLocaleString()}`);
        console.log(`  shed (channel full)    ${sum('shed').toLocaleString()}  (${(100*sum('shed')/Math.max(1,sum('sent')+sum('shed'))).toFixed(1)}% of offered L2 writes)`);
        console.log(`  congestion events      ${sum('cong').toLocaleString()}`);
        console.log(`  primary apply rate     ${(sum('sent')/secs/1000).toFixed(0)}k writes/s  (the single-writer ceiling)`);
        console.log(`  --- memory (second half of the run, after warm-up) ---`);
        if (warm.length < 8) {
            // Not enough warm samples to say anything about a trend. Say that,
            // rather than dividing by an empty window and crashing (or worse,
            // printing a confident number derived from two points).
            console.log(`  leak verdict           NOT MEASURED (${warm.length} warm samples; need 8+, i.e. a run of 6+ minutes)`);
        } else {
        show('worker heapUsed', 'wHeap');
        show('worker RSS', 'wRss');
        show('primary RSS', 'pRss');
        console.log(`  (worker RSS includes the ${(L2/1048576).toFixed(0)}MB shared arena as it pages in)`);
        // A fitted slope through a GC sawtooth is not evidence of a leak. The warm
        // heap series here ran 43,55,52,...,59,59,30 -- a 39MB band that ENDS 13MB
        // below where it started, yet fits at +1.03 MB/min purely from where the
        // samples land in the cycle. Judging on that slope alone reported a leak
        // on a run that plainly has none.
        //
        // Track the post-GC FLOOR instead: the minimum of each window is the live
        // set just after a collection, which sawtooth cannot push upward. If the
        // floor is rising, memory is genuinely being retained; if only the peaks
        // move, that is allocation rate, not a leak.
        // Boundaries must cover EVERY sample: `i * floor(n/parts)` silently drops
        // the tail, and dropping the tail is exactly how a falling series gets
        // reported as rising.
        const floors = (k, parts = 4) => {
            const out = [];
            if (warm.length < parts * 2) return out;
            for (let i = 0; i < parts; i++) {
                const a = Math.floor(i * warm.length / parts);
                const b = Math.floor((i + 1) * warm.length / parts);
                out.push(Math.min(...warm.slice(a, b).map(x => x[k] / 1048576)));
            }
            return out;
        };
        // Decide on HALVES, not quarters: the minimum of ~5 samples of a sawtooth
        // is itself noisy, and a leak verdict should not turn on one deep GC.
        const halfFloor = (k) => {
            const h = Math.floor(warm.length / 2);
            const lo = warm.slice(0, h).map(x => x[k] / 1048576);
            const hi = warm.slice(h).map(x => x[k] / 1048576);
            const mins = (warm[warm.length - 1].t - warm[h].t + warm[h - 1].t - warm[0].t) / 2 / 60000;
            return { a: Math.min(...lo), b: Math.min(...hi), rate: (Math.min(...hi) - Math.min(...lo)) / Math.max(0.1, mins) };
        };
        const HEAP_LEAK = 0.5, RSS_LEAK = 2.0;      // MB/min, applied to the FLOOR
        const hh = halfFloor('wHeap'), hp = halfFloor('pRss');
        const fh = hh.rate, fp = hp.rate;
        // What a run this long can actually resolve: a trend smaller than the
        // oscillation divided by the window is indistinguishable from phase.
        const warmMin = (warm[warm.length - 1].t - warm[0].t) / 60000;
        console.log(`  detection limit        heap +/-${(band('wHeap') / warmMin).toFixed(2)} MB/min, ` +
                    `primary RSS +/-${(band('pRss') / warmMin).toFixed(2)} MB/min over ${warmMin.toFixed(1)}m ` +
                    `(a smaller real leak would not be visible in this run)`);
        console.log(`  post-GC heap floor     ${floors('wHeap').map(x => x.toFixed(0) + 'MB').join(' -> ')}` +
                    `   halves ${hh.a.toFixed(0)}MB -> ${hh.b.toFixed(0)}MB (${fh >= 0 ? '+' : ''}${fh.toFixed(2)} MB/min)`);
        console.log(`  primary RSS floor      ${floors('pRss').map(x => x.toFixed(0) + 'MB').join(' -> ')}` +
                    `   halves ${hp.a.toFixed(0)}MB -> ${hp.b.toFixed(0)}MB (${fp >= 0 ? '+' : ''}${fp.toFixed(2)} MB/min)`);
        // A rate above threshold is not enough on its own. With a ~3 minute warm
        // window each quarter's floor is the minimum of only 4-5 samples, so one
        // deep GC moves it. Require the growth to STILL BE THERE at the end: the
        // final quarter's floor must be the highest of the four. A run whose
        // floors go 47 -> 59 -> 55 -> 49 rose and then came back down; that is
        // not a leak, and the earlier rule called it one.
        const stillRising = (k) => {
            const q = floors(k);
            return q.length >= 4 && q[q.length - 1] >= Math.max(...q);
        };
        leaking = (fh > HEAP_LEAK && stillRising('wHeap')) ||
                  (fp > RSS_LEAK && stillRising('pRss'));
        console.log(`  leak verdict           ${leaking ? '*** GROWING ***' : 'stable'}` +
                    `  (floor thresholds: heap ${HEAP_LEAK} MB/min, primary RSS ${RSS_LEAK} MB/min)`);

        }
        const pc = process.cpuUsage(pcpu0);
        const wCpuUs = sum('cpuUs'), pCpuUs = pc.user + pc.system, allUs = wCpuUs + pCpuUs;
        console.log(`  --- cpu ---`);
        console.log(`  worker CPU total       ${(wCpuUs/1e6).toFixed(1)}s across ${WORKERS} workers` +
                    ` = ${(100*wCpuUs/1e6/secs/WORKERS).toFixed(0)}% of a core each`);
        console.log(`  primary CPU            ${(pCpuUs/1e6).toFixed(1)}s = ${(100*pCpuUs/1e6/secs).toFixed(0)}% of one core`);
        console.log(`  CPU per cache op       ${(1000*allUs/Math.max(1,sum('ops'))).toFixed(0)} ns` +
                    `  (${(allUs/1e6).toFixed(1)}s CPU / ${sum('ops').toLocaleString()} ops)`);
        console.log(`  primary share of CPU   ${(100*pCpuUs/Math.max(1,allUs)).toFixed(1)}%  (it is the sole writer)`);
        console.log(`  WRONG VALUES           ${sum('wrong')}`);
        console.log(`  ERRORS                 ${sum('err')}`);
        const pass = sum('wrong') === 0 && sum('err') === 0 && !leaking;
        console.log(pass ? '\n  PASS' : '\n  FAIL');
        for (const id in cluster.workers) cluster.workers[id].kill();
        cache.close();
        process.exit(pass ? 0 : 1);
    }, MINUTES * 60000);
} else {
    const id = Number(process.env.WORKER_ID);
    const cache = TurboCache.attachWorker(ARENA, id, { storage: MODE, l1MaxBytes: L1 });
    const s = { t: 'stat', id, ops: 0, f1: 0, f2: 0, f3: 0, f4: 0, l1: 0, l2: 0, miss: 0,
                prop: 0, wrong: 0, err: 0, rss: 0, heap: 0, cpuUs: 0, upMs: 0,
                sent: 0, shed: 0, cong: 0 };
    const cpu0 = process.cpuUsage(), wall0 = Date.now();
    let ownVer = 0, sharedVer = 0;
    const lastSeen = new Map();          // shared key -> highest version this worker saw
    let rnd = id * 7919 + 13;
    const next = () => (rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296;

    function step() {
        const r = next();
        try {
            if (r < 0.40) {                                  // flow 1: L1-resident read
                const k = 'hot:' + ((next() * HOT) | 0);
                const before = cache.stats.l1Hits;
                const v = cache.get(k);
                if (v === undefined) { cache.set(k, makeVal(k, 1)); }
                else { const bad = verify(k, v); if (bad) s.wrong++; }
                if (cache.stats.l1Hits > before) s.l1++; else s.l2++;
                s.f1++;
            } else if (r < 0.65) {                           // flow 2: L1 miss -> L2
                const k = 'cold:' + ((next() * COLD) | 0);
                const b1 = cache.stats.l1Hits, b2 = cache.stats.l2Hits;
                const v = cache.get(k);
                if (v === undefined) { s.miss++; cache.set(k, makeVal(k, 1)); }
                else {
                    const bad = verify(k, v); if (bad) s.wrong++;
                    if (cache.stats.l2Hits > b2) s.l2++; else if (cache.stats.l1Hits > b1) s.l1++;
                }
                s.f2++;
            } else if (r < 0.80) {                           // flow 3: write own keys
                const k = `own:${id}:${(next() * 2000) | 0}`;
                if (cache.set(k, makeVal(k, ++ownVer)) !== true) s.err++;
                s.f3++;
            } else if (r < 0.90) {                           // flow 4: write shared keys
                const k = 'shared:' + ((next() * SHARED) | 0);
                if (cache.set(k, makeVal(k, ++sharedVer * 100 + id)) !== true) s.err++;
                s.f4++;
            } else {                                          // observe propagation
                const k = 'shared:' + ((next() * SHARED) | 0);
                const v = cache.get(k);
                if (v !== undefined) {
                    const bad = verify(k, v);
                    if (bad) s.wrong++;
                    else {
                        const ver = versionOf(v);
                        // a version whose worker-id suffix is not ours proves the
                        // value travelled through the arena from another worker
                        if (ver % 100 !== id && lastSeen.get(k) !== ver) { s.prop++; lastSeen.set(k, ver); }
                    }
                } else s.miss++;
            }
            s.ops++;
        } catch (e) { s.err++; if (s.err < 4) console.log(`  worker ${id} error: ${e.message}`); }
    }

    (function loop() {
        for (let i = 0; i < 4000; i++) step();
        cache.flush();
        const mu = process.memoryUsage(), cu = process.cpuUsage(cpu0);
        s.rss = mu.rss; s.heap = mu.heapUsed;
        s.cpuUs = cu.user + cu.system;          // total CPU consumed since start
        s.sent = cache.stats.sent; s.shed = cache.stats.writesShed || 0;
        s.cong = cache.stats.congested || 0;
        s.upMs = Date.now() - wall0;
        process.send(s);
        setImmediate(loop);      // yield: lets IPC flush and GC run, as a server would
    })();
}
