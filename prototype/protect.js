const { spawnSync } = require('child_process');
const l2 = require('./build/Release/l2.node');
const NAME = '/tc-prot-' + process.pid;
if (process.argv[2] === 'child') {
  if (!l2.attach(process.argv[3])) { console.error('attach failed'); process.exit(2); }
  console.log('  child: attached read-only, read ok =', l2.get('hello') === 'world');
  console.log('  child: attempting write through the mapping...');
  l2.poke();
  console.log('  child: WRITE SUCCEEDED - mapping is NOT protected');
  process.exit(3);
}
l2.create(NAME, 4 << 20, 1 << 12, 2);
l2.set('hello', 'world');
const r = spawnSync(process.execPath, [__filename, 'child', NAME], { stdio: 'inherit' });
console.log(`\n  child exit: status=${r.status} signal=${r.signal}`);
// POSIX raises SIGBUS/SIGSEGV on a write to a read-only mapping. Windows has no
// signals: the write raises EXCEPTION_ACCESS_VIOLATION and the process exits
// with 0xC0000005 (surfaced by Node as 3221225477, or as a negative status).
const faulted = process.platform === 'win32'
    ? (r.status === 3221225477 || r.status === -1073741819 || r.status === null)
    : (r.signal === 'SIGBUS' || r.signal === 'SIGSEGV');
console.log(faulted
  ? '  PASS: worker write faulted - the arena is protected by the MMU, not by convention'
  : `  FAIL: expected a memory fault, got status=${r.status} signal=${r.signal}`);
if (!faulted) process.exitCode = 1;
console.log('  primary still reads:', l2.get('hello'));
l2.destroy();
