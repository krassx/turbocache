// ESM declarations.
//
// index.d.ts describes a CommonJS module, because the package is
// "type": "commonjs". Under node16/nodenext TypeScript therefore models it as
// `module.exports`, and `import TurboCache from 'turbocache'` in an ESM
// consumer binds the whole namespace object rather than the class:
//
//   error TS2339: Property 'createPrimary' does not exist on type
//                 'typeof import(".../turbocache/index")'
//
// The runtime was always correct -- index.mjs has a real default export -- so
// this was types-only, which is the worse kind: correct code failed to compile.
// This file gives the `import` condition a true ES module declaration. It
// re-exports rather than duplicating, so there is exactly one place where the
// API is declared and the two can never drift.
export type {
    StorageMode, Transport, Codec, NamespaceOptions, HeapGuardOptions,
    CacheOptions, PrimaryOptions, OpenOptions, SetOptions, CacheStats,
    ArenaStats, NamespaceStat, AutoSize, SubmitStats, KeysOptions,
} from './index.js';

export { TurboCache, Cache, MSG } from './index.js';

import { TurboCache as _TurboCache } from './index.js';
export default _TurboCache;
