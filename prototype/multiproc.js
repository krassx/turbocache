// Validates the core architectural claim: primary writes an mmap'd arena while
// N worker processes read it through a PROT_READ mapping, and no reader ever
// observes a torn or wrong value.
const { fork } = require('child_process');
const l2 = require('./build/Release/l2.node');

const NAME = '/tc-mp-' + process.pid;
const NKEYS = Number(process.env.NKEYS || 3000);
const WORKERS = Number(process.env.WORKERS || 4);
const SECONDS = Number(process.env.SECONDS || 5);
const ARENA = Number(process.env.ARENA || (16 << 20));

// value is fully determined by (key, version) so any reader can self-verify
function makeVal(k, v) {
  const len = 40 + (v * 137) % 3000;
  return `${k}#${v}#` + String.fromCharCode(97 + (v % 26)).repeat(len);
}
function verify(k, s) {
  const p = s.indexOf('#'), q = s.indexOf('#', p + 1);
  if (p < 0 || q < 0) return 'no-delims';
  if (s.slice(0, p) !== k) return 'key-mismatch';
  const v = Number(s.slice(p + 1, q));
  if (!Number.isInteger(v)) return 'bad-version';
  const expect = makeVal(k, v);
  return s === expect ? null : 'payload-mismatch';
}

if (process.argv[2] === 'child') {
  const name = process.argv[3];
  if (!l2.attach(name)) { process.send({ err: 'attach failed' }); process.exit(1); }
  let hits = 0, misses = 0, corrupt = 0, samples = [];
  const stop = Date.now() + SECONDS * 1000;
  while (Date.now() < stop) {
    for (let n = 0; n < 20000; n++) {
      const k = 'k:' + ((Math.random() * NKEYS) | 0);
      const got = l2.get(k);
      if (got === undefined) { misses++; continue; }
      hits++;
      const bad = verify(k, got);
      if (bad) { corrupt++; if (samples.length < 3) samples.push(`${k}: ${bad}`); }
    }
  }
  process.send({ hits, misses, corrupt, samples });
  process.exit(0);
}

if (!l2.create(NAME, ARENA, 1 << 16, 2)) { console.error('create failed'); process.exit(1); }
l2.backwardShift(process.env.SHIFT !== '0');
l2.setCompressMin(1 << 30);
for (let i = 0; i < NKEYS; i++) l2.set('k:' + i, makeVal('k:' + i, 0));

const kids = [];
let done = 0, totals = { hits: 0, misses: 0, corrupt: 0 }, allSamples = [];
for (let w = 0; w < WORKERS; w++) {
  const c = fork(__filename, ['child', NAME]);
  c.on('message', m => {
    if (m.err) { console.error('child:', m.err); process.exit(1); }
    totals.hits += m.hits; totals.misses += m.misses; totals.corrupt += m.corrupt;
    allSamples.push(...m.samples);
    if (++done === WORKERS) finish();
  });
  kids.push(c);
}

// primary rewrites continuously with changing versions AND changing sizes,
// so blocks are constantly reused underneath live readers
let version = 1, writes = 0;
const stop = Date.now() + SECONDS * 1000;
const timer = setInterval(() => {
  if (Date.now() > stop) { clearInterval(timer); return; }
  for (let n = 0; n < 20000; n++) {
    const i = (Math.random() * NKEYS) | 0, k = 'k:' + i;
    l2.set(k, makeVal(k, version++));
    writes++;
  }
}, 1);

function finish() {
  clearInterval(timer);
  const s = l2.stats();
  console.log(`writers: 1 primary (${writes.toLocaleString()} writes)   readers: ${WORKERS} forked processes`);
  console.log(`reads:   ${totals.hits.toLocaleString()} hits, ${totals.misses.toLocaleString()} misses`);
  console.log(`CORRUPT/TORN READS: ${totals.corrupt}`);
  if (allSamples.length) console.log('  samples:', allSamples.slice(0, 5));
  console.log(`arena:   live=${s.live} evictions=${s.evictions.toLocaleString()} util=${(100*s.liveBytes/s.dataBytes).toFixed(0)}%`);
  l2.destroy();
  process.exit(totals.corrupt === 0 ? 0 : 1);
}
