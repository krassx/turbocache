// Type-level tests for index.d.ts.
//
// The `@ts-expect-error` lines are the point: a declaration file that accepts
// everything type-checks fine and is worthless. tsc reports TS2578 for an
// UNUSED expect-error, so this file only passes when each of those really is
// an error and every line above them really is not.
import { TurboCache, Cache, MSG } from 'turbocache';
import type { CacheOptions, StorageMode, Codec, CacheStats } from 'turbocache';

// --- inference -------------------------------------------------------------
const c = TurboCache.createPrimary<{ a: number }>('/t', 1, 1, { storage: 'bytes' });
const v = c.get('k');                       // {a:number} | undefined
const n: number | undefined = v?.a;
const okSet: boolean = c.set('k', { a: 1 });
const present: boolean = c.has('k');
const removed: boolean = c.delete('k');
const size: number = c.size;
const t: 'shm' | 'ipc' = c.transport;
const s: CacheStats = c.stats;
const hits: number = s.l1Hits;
const err: string | null = c.lastError;
for (const key of c.keys({ limit: 10 })) { const k: string = key; void k; }
const strC = TurboCache.createPrimary<string>('/t2', 1, 1, {});
const sv: string | undefined = strC.get('k');
const codec: Codec<{ a: number }> = { encode: (x) => JSON.stringify(x), decode: (x) => JSON.parse(x) };
const opts: CacheOptions<{ a: number }> = { codec, freeze: true, l1MaxBytes: 1024 };
const mode: StorageMode = 'direct';
void [n, okSet, present, removed, size, t, hits, err, sv, opts, mode, Cache, MSG];

// --- these MUST be errors --------------------------------------------------
// @ts-expect-error storage mode is a closed set
const bad1 = TurboCache.createPrimary('/t', 1, 1, { storage: 'nope' });
// @ts-expect-error value must match the cache's type parameter
const bad2 = c.set('k', { a: 'string-not-number' });
// @ts-expect-error get returns T | undefined, not T
const bad3: { a: number } = c.get('k');
// @ts-expect-error no such method
const bad4 = c.nonexistentMethod();
// @ts-expect-error internal plumbing must not be part of the public surface
const bad5 = c._dropByHash('x');
// @ts-expect-error transport is a closed set
const bad6: CacheOptions = { transport: 'carrier-pigeon' };
void [bad1, bad2, bad3, bad4, bad5, bad6];
