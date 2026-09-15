'use strict';
// CommonJS entry point. The implementation lives in src/; this exists so that
// `require('turbokv')` resolves without the package's internal layout
// leaking into consumers' import paths.
module.exports = require('./src/turbokv.js');
