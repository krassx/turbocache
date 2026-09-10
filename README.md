# turbocache

A layered in-memory KV cache for Node.js clusters.

**L1** is a per-process JS `Map` with a byte budget. **L2** is a shared-memory
arena the primary owns and workers map *read-only* — the fd is opened `O_RDONLY`,
so a worker cannot write the arena even deliberately. Worker writes travel to the
primary through per-worker shared-memory submission rings rather than the cluster
IPC channel.

```js
const { TurboCache } = require('turbocache');
// or: import { TurboCache } from 'turbocache';

// primary, before forking
const cache = TurboCache.open();
TurboCache.install(require('cluster'));

// anywhere
cache.set('user:42', 'ada', { ttlMs: 60_000 });
cache.get('user:42');        // 'ada'
```

## Why the rings

`process.send` was never bandwidth-limited — the raw channel carries 439 MB/s
under JSON. Its costs are that each send *synchronously freezes* the sending
worker's event loop while V8 serialises the batch (0.49ms p50, 1.15ms p99 for a
~525KB batch), and that it is the one channel the application shares for its own
messages. Measured against a control doing identical work that never reaches the
channel, cache traffic degraded an application's own IPC round trip from 0.69ms
to 13.59ms at p99. Rings replace that with a memcpy:

| | delivered | shed | worker loop p99 |
|---|---|---|---|
| cluster IPC | 551k writes/s | 41.7% | 5.70ms |
| shared memory | **1180k writes/s** | **0%** | **4.03ms** |

## Storage modes

| mode | stores | keeps `Date`/`Map`/`Set` | cost |
|---|---|---|---|
| `bytes` *(default)* | primitives + binary, no codec | rejects them | 1504 ns/op |
| `safe` | JSON | silently degrades them | 1789 ns/op |
| `direct` | `v8.serialize` | yes | 3250 ns/op |

`direct`'s format is runtime-specific: Bun's differs from Node's and Deno's, so
an arena written by one runtime cannot be read by another.

## Runtime support

| | Node | Bun | Deno |
|---|---|---|---|
| addon, cluster, both transports | yes | yes | yes |
| CJS + ESM entry points | yes | yes | yes |
| post-GC heap guard | yes | **no** | **no** |

Bun and Deno accept a `gc` `PerformanceObserver` but never emit entries, so the
heap guard is inert there and L1 is bounded only by the byte estimate. One known
Deno failure remains under the `direct` codec; see DESIGN.md.

## Operational notes

- **Sizing**: on Linux the arena is backed by `/dev/shm`. Docker defaults it to
  64MB — pass `--shm-size` or `create()` fails with a message naming it.
- **Worker ids** start at 1. `0` is the primary and is rejected.
- **`set` never throws.** An unusable key, value or type returns `false` with the
  reason in `lastError`.
- **Primary death**: a worker detaches, keeps serving its warm L1, polls, and
  recovers when a heartbeat *advances* — then flushes L1 and re-claims a ring.

The full design, decision log and measurements — including what was built and
rejected — are in [DESIGN.md](DESIGN.md).

## License

MIT. Vendors [rapidhash](prototype/vendor/rapidhash.h) (MIT).
