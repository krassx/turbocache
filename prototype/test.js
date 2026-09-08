const l2 = require('./build/Release/l2.node');
const { makePayload } = require('./payload');
let fails = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); fails++; } };

for (const [mode, name] of [[0, 'SLAB'], [1, 'LOG'], [2, 'LOG2']]) {
  console.log(`\n=== ${name} ===`);
  l2.create(`/tc-test-${mode}`, 8 << 20, 1 << 15, mode);

  for (const len of [1, 10, 100, 255, 256, 1000, 5000, 50000]) {
    const k = 'k:' + len, v = makePayload(len);
    ok(l2.set(k, v), `set len=${len}`);
    ok(l2.get(k) === v, `roundtrip len=${len}`);
  }
  ok(l2.get('nope') === undefined, 'miss returns undefined');
  l2.set('ow', 'first'); l2.set('ow', 'second-and-longer');
  ok(l2.get('ow') === 'second-and-longer', 'overwrite');

  // 5k distinct keys: verify memcmp catches any bucket sharing
  const vals = new Map();
  for (let i = 0; i < 5000; i++) { const v = makePayload(200); vals.set('c:'+i, v); l2.set('c:'+i, v); }
  let bad = 0;
  for (const [k, v] of vals) { const g = l2.get(k); if (g !== undefined && g !== v) bad++; }
  ok(bad === 0, `no wrong-value returns (${bad} bad)`);

  // overfill: 20k x ~2KB realistic = ~40MB raw into a ~7MB region
  const exp = new Map();
  let setOk = 0, setFail = 0;
  for (let i = 0; i < 20000; i++) {
    const v = makePayload(2000); exp.set('f:'+i, v);
    l2.set('f:'+i, v) ? setOk++ : setFail++;
  }
  let present = 0, wrong = 0;
  for (const [k, v] of exp) { const g = l2.get(k); if (g === undefined) continue; present++; if (g !== v) wrong++; }
  ok(wrong === 0, `after overfill: ${wrong} wrong values`);
  const s = l2.stats();
  ok(s.evictions > 0, `eviction happened (${s.evictions})`);
  ok(setFail === 0, `no failed sets (${setFail} failed)`);
  console.log(`  set ok=${setOk} fail=${setFail} | present=${present}/20000 | evictions=${s.evictions}`);
  console.log(`  live=${s.live} liveBytes=${(s.liveBytes/1048576).toFixed(2)}MB of ${(s.dataBytes/1048576).toFixed(1)}MB` +
              `  utilisation=${(100*s.liveBytes/s.dataBytes).toFixed(1)}%`);
  l2.destroy();
}
console.log(fails ? `\n${fails} FAILURES` : '\nall passed');
process.exit(fails ? 1 : 0);
