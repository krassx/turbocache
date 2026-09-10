/**
 * turbocache — a layered in-memory KV cache for Node.js clusters.
 *
 * L1 is a per-process JS Map with a byte budget; L2 is a shared-memory arena
 * that the primary owns and workers map read-only. Worker writes travel to the
 * primary through per-worker shared-memory submission rings.
 *
 * These declarations are hand-written against turbocache.js. They describe the
 * PUBLIC surface only: anything prefixed with `_` is internal cross-instance
 * plumbing and is deliberately absent.
 */

/** How values are encoded on their way into the arena. */
export type StorageMode =
    /** No codec. Strings, numbers, booleans, null, BigInt and binary only;
     *  byte accounting is exact and there is no aliasing hazard. The default. */
    | 'bytes'
    /** `v8.serialize`. Full fidelity: Date, Map, Set, BigInt and typed arrays
     *  survive the round trip. Costs ~2-3x JSON and allocates per L2 hit.
     *  NOTE: the format is runtime-specific — Bun's differs from Node's and
     *  Deno's, so an arena written by one cannot be read by the other. */
    | 'direct'
    /** JSON. Silently degrades eight common types (Date to string, Map/Set to
     *  {}, NaN/Infinity to null, undefined dropped) and rejects BigInt and
     *  cycles. Fast and universally understood. */
    | 'safe'
    /** @deprecated Legacy alias for `'bytes'`. */
    | 'primitives';

/** How a worker's writes reach the primary. */
export type Transport =
    /** Per-worker shared-memory submission rings. The default. */
    | 'shm'
    /** Batched over the cluster IPC channel. Slower, and it shares the channel
     *  with the application's own messages. */
    | 'ipc';

/** A caller-supplied codec. Must not pass a replacer/reviver or indentation:
 *  a replacer costs 3.5x on Node 26 and is rejected unless `allowSlowCodec`. */
export interface Codec<T = unknown> {
    encode(value: T): string;
    decode(encoded: string): T;
}

export interface NamespaceOptions {
    name: string;
    /** Soft byte quota. A namespace under its quota is protected from eviction
     *  by a hotter one; over it, it competes normally. 0 means no quota. */
    quotaBytes?: number;
}

/** Bounds L1 by live heap measured after a GC, since the byte budget is only
 *  an estimate. Pass `false` to disable.
 *  NOTE: this relies on gc PerformanceObserver entries, which Bun and Deno
 *  accept but never emit — the guard is inert on those runtimes. */
export interface HeapGuardOptions {
    /** Shed L1 once live heap exceeds this fraction of the limit. Default 0.80. */
    maxHeapFraction?: number;
    /** Fraction of L1 bytes to release when it fires. Default 0.25. */
    shedFraction?: number;
}

export interface CacheOptions<T = unknown> {
    /** @see StorageMode. Default `'bytes'`. */
    storage?: StorageMode;
    /** Legacy alias for `storage`. */
    values?: StorageMode;
    /** Explicit codec. Mutually exclusive with a `storage` mode that implies one. */
    codec?: Codec<T>;
    /** Permit a codec that takes a replacer/reviver or indentation. Off by default
     *  because it silently costs 2-3.5x. */
    allowSlowCodec?: boolean;
    /** Freeze cached objects so a caller mutating one raises instead of
     *  corrupting L1. Also neutralises Date/Map/Set mutators, which
     *  `Object.freeze` cannot reach. */
    freeze?: boolean;
    /** Decode once per `set` so L1 never aliases the caller's object. */
    isolate?: boolean;
    /** L1 byte budget for this process. Default 2MB. 0 disables L1. */
    l1MaxBytes?: number;
    /** Multiplier from encoded bytes to retained heap. Measured 2.79-3.21x for
     *  JSON-shaped objects. Default 3. */
    heapFactor?: number;
    heapGuard?: HeapGuardOptions | false;
    /** Prefix and arena-level identity, optionally carrying a byte quota. */
    namespace?: string | NamespaceOptions;
    /** @see Transport. Default `'shm'`. */
    transport?: Transport;
    /** Bytes a worker may hold in the IPC outbox before shedding. Default 1MB. */
    outboxMaxBytes?: number;
    /** Bytes handed to `process.send` and not yet drained. 0 sends nothing.
     *  Default 8MB. */
    maxInFlightBytes?: number;
    /** How stale the primary's heartbeat may get before a worker detaches and
     *  serves L1 only. Default 5000ms. */
    primaryStaleMs?: number;
    /** Run the primary's maintenance timer (heartbeat, expiry sweep). */
    maintenance?: boolean;
    maintenanceMs?: number;
    sweepSlots?: number;
    sweepFullPassMs?: number;
}

export interface PrimaryOptions<T = unknown> extends CacheOptions<T> {
    /** Number of worker submission ring slots. Default 32. */
    submitRings?: number;
    /** Bytes per submission ring. Default 1MB. A value larger than half a ring
     *  can never be delivered and `set` reports it as a rejection. */
    submitRingBytes?: number;
    /** Requires an addon built with `--turbocache_lz4=1`. Measured a poor trade;
     *  neither the default nor a build dependency. */
    compress?: boolean;
    compressMinBytes?: number;
    compressAccel?: number;
}

export interface OpenOptions<T = unknown> extends PrimaryOptions<T> {
    /** Segment name. Defaults to one derived from the application's identity so
     *  a restart reclaims its own segment. */
    name?: string;
    arenaBytes?: number;
    indexSlots?: number;
}

export interface SetOptions {
    /** Time to live. Clamped to ~24.8 days; longer values are capped, never
     *  wrapped into "no expiry". */
    ttlMs?: number;
}

export interface CacheStats {
    sets: number; deletes: number; misses: number;
    l1Hits: number; l2Hits: number;
    invalidated: number; expired: number;
    /** Writes accepted locally that never reached L2 (ring or channel full). */
    writesShed?: number;
    sent?: number; flushes?: number; flushDropped?: number; congested?: number;
    rejectedKey?: number; rejectedType?: number; rejectedSize?: number;
    heapShed?: number; incrQueued?: number;
    /** Times this worker re-attached after losing its primary. */
    recoveries?: number;
    lastRecovery?: { sameArena: boolean; at: number } | null;
    [k: string]: unknown;
}

export interface ArenaStats {
    live: number; liveBytes: number; evictions: number;
    inserts: number; allocBytes: number;
    [k: string]: number;
}

export interface NamespaceStat {
    name: string; id: number; bytes: number; quota: number;
    protected: number; dropped: number;
}

export interface AutoSize {
    arenaBytes: number; indexSlots: number; l1MaxBytes: number;
}

export interface SubmitStats {
    pushed: number; applied: number; shed: number; corrupt: number;
    rings: number; enabled: number; ringIndex: number;
}

export interface KeysOptions {
    /** Maximum keys to yield. Default 1000. */
    limit?: number;
    /** Index slots scanned per native call. Default 512. */
    batch?: number;
}

/**
 * A cache handle. Every method is synchronous.
 *
 * `set` never throws: an unusable key, value or type is reported as `false`
 * with the reason in `lastError`.
 */
export declare class TurboCache<T = unknown> {
    constructor(options?: CacheOptions<T>);

    /** Create the arena and become its sole writer. Call before forking. */
    static createPrimary<V = unknown>(
        name: string, arenaBytes: number, indexSlots: number, options?: PrimaryOptions<V>
    ): TurboCache<V>;

    /** Attach read-only from a worker. `workerId` must be an integer >= 1;
     *  0 is the primary and is rejected. */
    static attachWorker<V = unknown>(
        name: string, workerId: number, options?: CacheOptions<V>
    ): TurboCache<V>;

    /** Create or attach automatically, choosing the role from `cluster`. */
    static open<V = unknown>(options?: OpenOptions<V>): TurboCache<V>;

    /** Wire the primary to apply worker batches. Idempotent. */
    static install(cluster: unknown): void;

    static arenaStats(): ArenaStats;
    static namespaceStats(): NamespaceStat[];
    static submitStats(): SubmitStats | null;
    /** Milliseconds since the primary last stamped its heartbeat; -1 if never. */
    static primaryAgeMs(): number;
    static autoSize(): AutoSize;
    static defaultName(): string;
    /** Whether the loaded addon was built with LZ4. */
    static hasCompression(): boolean;
    /** Apply pending worker submissions on the primary. Returns records applied. */
    static drainSubmissions(budget?: number): number;

    get(key: string): T | undefined;
    set(key: string, value: T, options?: SetOptions): boolean;
    has(key: string): boolean;
    /** Returns whether the key was present at call time. */
    delete(key: string): boolean;
    /** Numeric counter. On the primary returns the new value; from a worker the
     *  update is applied a tick later and this returns `undefined`. */
    incr(key: string, by?: number, options?: SetOptions): number | undefined;
    /** Compare and swap. Primary only. */
    cas(key: string, expected: T, next: T, options?: SetOptions): boolean;

    /** Drop this process's L1. The arena is untouched. */
    clearLocal(): void;
    /** Clear the whole arena and every process's L1. */
    clearAll(): void;
    clearNamespace(): number;

    /** Lazily enumerate keys. Not a snapshot: the arena may change mid-scan. */
    keys(options?: KeysOptions): Generator<string, void, unknown>;
    /** Counts by enumerating, so it is O(index slots), not a cached counter. */
    get size(): number;

    /** Which write path this handle negotiated. */
    get transport(): Transport;

    /** Push any buffered worker writes now. */
    flush(): void;
    /** Release the ring slot, stop the heap guard, deregister, and on the
     *  primary destroy the arena. */
    close(): void;

    readonly stats: CacheStats;
    /** Why the last operation failed, or null. */
    lastError: string | null;
    /** Live heap fraction sampled after the last GC. Stays 0 on runtimes that
     *  do not emit gc performance entries (Bun, Deno). */
    readonly liveHeapFraction: number;
}

export { TurboCache as Cache };
/** Message tag used on the cluster channel. */
export declare const MSG: string;
export default TurboCache;
