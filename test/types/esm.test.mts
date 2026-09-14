// Type-level tests for the ESM condition (index.d.mts).
//
// A .mts file is an ES module regardless of the package's "type", so resolving
// 'turbocache' from here goes through exports["."].import.types -- the path a
// real ESM TypeScript consumer takes. Before index.d.mts existed, the default
// import below failed with:
//
//   TS2339: Property 'createPrimary' does not exist on type
//           'typeof import(".../turbocache/index")'
//
// because index.d.ts describes a CommonJS module, so `default` modelled the
// whole namespace object. The runtime was fine; only the types were wrong.
import TurboCache, { Cache, MSG } from 'turbocache';
import type { CacheOptions, CacheStats, StorageMode } from 'turbocache';

// The default export must BE the class, not the module namespace.
const c = TurboCache.createPrimary<{ a: number }>('/t', 1, 1, { storage: 'bytes' });
const v = c.get('k');                         // {a:number} | undefined
const n: number | undefined = v?.a;
const s: CacheStats = c.stats;
const hits: number = s.l1Hits;
const tag: string = MSG;

// The named exports must come through the same file and mean the same things.
const c2 = Cache.createPrimary<{ a: number }>('/t2', 1, 1, {});
const opts: CacheOptions<{ a: number }> = { storage: 'direct' };
const mode: StorageMode = 'safe';

// Cache is an alias of TurboCache, so the two are assignable both ways.
const alias: typeof TurboCache = Cache;
const alias2: typeof Cache = TurboCache;

// --- and the declaration must still REJECT misuse on this path too ---------
// @ts-expect-error storage is a fixed set of modes
const bad1: CacheOptions = { storage: 'nope' };
// @ts-expect-error createPrimary needs a name, size and slot count
TurboCache.createPrimary<{ a: number }>('/t');
// @ts-expect-error the value type is enforced against the cache's parameter
c.set('k', { a: 'not a number' });
// @ts-expect-error the addon is not on the public surface
TurboCache.native();

void [n, hits, tag, c2, opts, mode, alias, alias2, bad1];
