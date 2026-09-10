'use strict';
// Single place the compiled addon is resolved from.
//
// Every module used to require '../build/Release/<name>.node' directly, so the
// path and the target name were duplicated across twenty files and a rename
// meant touching all of them. It is also the natural seam for prebuild
// resolution: when prebuilt binaries land, the fallback chain belongs here and
// nowhere else.
module.exports = require('../build/Release/turbocache.node');
