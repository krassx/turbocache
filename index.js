'use strict';
// CommonJS entry point. The implementation lives in src/; this exists so that
// `require('turbocache')` resolves without the package's internal layout
// leaking into consumers' import paths.
module.exports = require('./src/turbocache.js');
