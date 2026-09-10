# `v8.getHeapStatistics()` is O(heap) on Bun and costs ~2x a full GC

Run: `node heapstats-cost.mjs` / `bun heapstats-cost.mjs`
(no dependencies, no native addons, single file)

## Status

Reported upstream; a fix is in progress in **oven-sh/bun#30596**, unmerged as of
2026-09-10. The measurements below describe Bun 1.4.2 and should be re-run
against any release that includes that PR before being cited.

## Summary

On Bun, `v8.getHeapStatistics()` takes time proportional to heap size — 3.2ms at
a 17MB heap rising to **74ms at 411MB**. On Node the same call is constant-time
at ~110ns regardless of heap size. A single 74ms synchronous call blocks the
event loop for longer than most request budgets.

Measured on Bun 1.4.2, darwin/arm64, against Node 24.15.0.

## Numbers

| live heap | Bun `getHeapStatistics()` | Node `getHeapStatistics()` |
|---|---|---|
| 17 MB | 3.19 ms | ~110 ns |
| 72 MB | 12.80 ms | ~110 ns |
| 101 MB | 31.84 ms | ~115 ns |
| 411 MB | 74.03 ms | ~105 ns |

Reproduces within ~1% across runs.

## It is not general interop overhead

`process.memoryUsage()` is measured alongside as a control, on the same runtime,
in the same process:

| | Bun | Node |
|---|---|---|
| `process.memoryUsage().heapUsed` | 375 ns, flat | ~490 ns, flat |
| `v8.getHeapStatistics()` | 3.2 → 74 ms, grows | ~110 ns, flat |

So Bun's `process.memoryUsage()` is *faster* than Node's. Only
`getHeapStatistics` shows the behaviour.

## What it appears to be doing

Two checks in the script:

- **It does not collect.** Heap is 413.7MB before the call and 413.7MB after, so
  it is not a garbage collection with the statistics as a side effect.
- **It costs about twice a full GC.** On the same runtime and heap:
  `Bun.gc(true)` 36.17 ms/call, `v8.getHeapStatistics()` 72.67 ms/call — a ratio
  of **2.01x**. On Node the relationship is inverted: `global.gc()` 74.59 ms,
  `getHeapStatistics()` under 0.01 ms.

Together that suggests a full heap walk to compute the statistics, rather than
reading maintained counters — and possibly walking it twice.

## Why it matters

Any code sampling heap statistics on a timer or in response to GC activity
inherits an O(heap) synchronous stall. In our case a cache heap-guard sampling a
few times a second on a 400MB heap would spend a large fraction of the event
loop inside this one call; we had to add a debounce specifically to bound it.
`process.memoryUsage()` is not a substitute, because on Bun it reports a
different figure — it stayed flat at 9.4MB while `used_heap_size` grew — and
`heap_size_limit` is not stable there either (observed 318MB → 644MB as the heap
grew), so neither the numerator nor the denominator of a
`used / limit` guard can be shortcut.
