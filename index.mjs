// ESM entry point.
//
// The implementation stays CommonJS: it is loaded by cluster workers, by the
// native addon's consumers and by three different runtimes, and a single CJS
// source with a wrapper is the form all of them agree on. createRequire is the
// supported way to reach it from ESM without duplicating the module.
//
// Named exports are listed explicitly rather than re-exported wholesale so that
// `import { TurboCache } from 'turbocache'` is statically analysable by
// bundlers, which cannot see through a dynamic require.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/turbocache.js');

export const TurboCache = mod.TurboCache;
export const Cache = mod.Cache;
export const MSG = mod.MSG;
export default mod.TurboCache;
