// Does a worker holding a PROT_READ arena mapping actually record reference
// bits that the primary can see? This is the whole fix for gap 1.
const { spawnSync } = require('child_process');
const l2 = require('./build/Release/l2.node');
const NAME = '/tc-hints-' + process.pid;
if (process.argv[2] === 'child') {
  if (!l2.attach(process.argv[3])) { console.error('attach failed'); process.exit(2); }
  let hit = 0;
  for (let i = 0; i < 100; i++) if (l2.get('k:' + i) !== undefined) hit++;   // read ONLY the first 100
  console.log(`  child: read 100 keys read-only, ${hit} hits`);
  process.exit(0);
}
l2.create(NAME, 16 << 20, 1 << 16, 2);
l2.setCompressMin(1 << 30);
for (let i = 0; i < 5000; i++) l2.set('k:' + i, 'v'.repeat(200));
l2.clearHints();
console.log('  primary: wrote 5000 keys, then cleared all reference bits ->', l2.hintsSet(), 'set');
spawnSync(process.execPath, [__filename, 'child', NAME], { stdio: 'inherit' });
const after = l2.hintsSet();
console.log('  primary: after the child read 100 keys ->', after, 'set');
console.log(after >= 90 && after <= 110
  ? '  PASS: worker reference bits are visible to the primary, from a read-only arena mapping'
  : `  FAIL: expected ~100, got ${after}`);
l2.destroy();
