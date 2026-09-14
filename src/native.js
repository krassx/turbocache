'use strict';
// Single place the compiled addon is resolved from.
//
// Every module used to require '../build/Release/<name>.node' directly, so the
// path and the target name were duplicated across twenty files and a rename
// meant touching all of them.
//
// node-gyp-build resolves in this order: a prebuild matching this platform,
// arch and libc under prebuilds/, then a local build/Release or build/Debug.
// Because the addon is Node-API, the ABI is stable across Node majors, so one
// prebuild per platform serves every supported Node -- there is no per-version
// matrix to maintain. It is a dependency-free single file; the package
// otherwise has no runtime dependencies and that stays true in spirit.
module.exports = require('node-gyp-build')(require('path').join(__dirname, '..'));
