const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');

const NKEYS = 4000;
const bodies = new Map();                       // key -> current expected value
function write(k, gen) {
  const v = `${k}#${gen}#` + makePayload(1200);
  bodies.set(k, v);
  l2.set(k, v);
}
function auditAll() {
  let checked = 0, wrong = 0, resurrected = 0, missing = 0;
  for (const [k, want] of bodies) {
    const got = l2.get(k);
    if (got === undefined) { missing++; continue; }
    checked++;
    if (got !== want) {
      wrong++;
      const g = Number(got.split('#')[1]), w = Number(want.split('#')[1]);
      if (Number.isInteger(g) && Number.isInteger(w) && g < w) resurrected++;
    }
  }
  return { checked, wrong, resurrected, missing };
}

const COLD = process.env.COLD === '1';
function compact(maxItems, minBytes, delayUs) {
  return new Promise(res => l2.compactAsync(maxItems, minBytes, delayUs, COLD, res));
}

(async () => {
  l2.create('/tc-race-' + process.pid, 24 << 20, 1 << 16, 2);
  l2.setCompressMin(1 << 30);                   // writes are uncompressed; only compaction compresses
  for (let i = 0; i < NKEYS; i++) write('k:' + i, 0);

  console.log('--- 1. quiet compaction (no concurrent writes) ---');
  let r = await compact(2000, 256, 0);
  console.log(`  captured->applied=${r.applied} stale=${r.stale} noGain=${r.noGain} reclaimed=${(r.reclaimed/1024).toFixed(0)}KB`);
  let a = auditAll();
  console.log(`  audit: checked=${a.checked} wrong=${a.wrong} resurrected=${a.resurrected}`);

  console.log('\n--- 2. compaction racing a heavy overwrite burst ---');
  let gen = 1, totalStale = 0, totalApplied = 0, worstAudit = null;
  for (let round = 0; round < 12; round++) {
    // schedule compaction with a widened window, then overwrite underneath it
    const p = compact(1500, 256, 40000);        // 40ms of off-thread work
    for (let i = 0; i < NKEYS; i++) write('k:' + i, gen);   // synchronous, concurrent with the threadpool
    gen++;
    const rr = await p;
    totalStale += rr.stale; totalApplied += rr.applied;
    const aa = auditAll();
    if (!worstAudit || aa.wrong > worstAudit.wrong) worstAudit = aa;
    if (aa.wrong) console.log(`  round ${round}: WRONG=${aa.wrong} resurrected=${aa.resurrected}`);
  }
  console.log(`  applied=${totalApplied} stale(discarded)=${totalStale}`);
  console.log(`  audit worst round: checked=${worstAudit.checked} wrong=${worstAudit.wrong} resurrected=${worstAudit.resurrected}`);

  const s = l2.compactStats(), st = l2.stats();
  console.log(`\n  cumulative: applied=${s.applied} stale=${s.stale} noGain=${s.noGain} reclaimed=${(s.reclaimed/1048576).toFixed(2)}MB`);
  console.log(`  arena: live=${st.live} util=${(100*st.liveBytes/st.dataBytes).toFixed(0)}%`);

  console.log('\n--- 3. realistic: compaction racing a 5% overwrite rate ---');
  let a3 = 0, s3 = 0;
  for (let round = 0; round < 12; round++) {
    const p = compact(1500, 256, 20000);
    for (let n = 0; n < NKEYS * 0.05; n++) write('k:' + ((Math.random()*NKEYS)|0), gen);
    gen++;
    const rr = await p;
    a3 += rr.applied; s3 += rr.stale;
  }
  const aud3 = auditAll();
  console.log(`  applied=${a3} stale=${s3}  (${(100*a3/(a3+s3)).toFixed(0)}% of captures made progress)`);
  console.log(`  audit: checked=${aud3.checked} wrong=${aud3.wrong} resurrected=${aud3.resurrected}`);

  const raced = totalStale > 0;
  const clean = worstAudit.wrong === 0 && aud3.wrong === 0;
  const progressed = a3 > 0;
  console.log(`\n  race actually exercised: ${raced ? 'YES' : 'NO - test is not proving anything'}`);
  console.log(`  correctness: ${clean ? 'PASS - no stale value ever published' : 'FAIL'}`);
  console.log(`  makes progress under contention: ${progressed ? 'YES' : 'NO'}`);
  l2.destroy();
  process.exit(raced && clean && progressed ? 0 : 1);
})();
