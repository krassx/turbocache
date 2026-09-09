// Locates LZ4 for the optional --turbocache_lz4=1 build. Tries pkg-config, then
// the usual prefixes. Prints "<includedir>|<libdir>" or exits non-zero.
const { execSync } = require('child_process');
const fs = require('fs');
function tryPkgConfig() {
    try {
        const inc = execSync('pkg-config --variable=includedir liblz4', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const lib = execSync('pkg-config --variable=libdir liblz4', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (inc && fs.existsSync(`${inc}/lz4.h`)) return `${inc}|${lib}`;
    } catch { /* pkg-config absent or lz4 unknown to it */ }
    return null;
}
const prefixes = [process.env.LZ4_PREFIX, '/opt/homebrew', '/usr/local', '/usr', '/opt/local'].filter(Boolean);
const found = tryPkgConfig() ||
    prefixes.map(p => `${p}/include|${p}/lib`).find(pair => fs.existsSync(pair.split('|')[0] + '/lz4.h'));
if (!found) {
    process.stderr.write('turbocache: --turbocache_lz4=1 requested but lz4.h was not found. ' +
        'Install LZ4 (brew install lz4 / apt install liblz4-dev) or set LZ4_PREFIX.\n');
    process.exit(1);
}
// Print one field at a time. binding.gyp used to pipe this through `cut`, which
// does not exist on Windows - the gyp <!() command runs in the platform shell.
const which = process.argv[2];
const [inc, lib] = found.split('|');
process.stdout.write(which === 'lib' ? lib : which === 'include' ? inc : found);
