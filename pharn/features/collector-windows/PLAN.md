---
spec_id: collector-windows
spec_content_hash: 9342a6f9e40a234724bf174a29e016a29738b05d7ab059d80b29afed60d69bec
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `collector-windows` (ROADMAP S2, slice 1).

Discovery (live, this run): the repo is a single npm package (`"type": "module"`, dual ESM/CJS build via
`scripts/build.mjs` with `tsconfig.esm.json` / `tsconfig.cjs.json`, both `rootDir: src`, tests excluded),
vitest with `include: ['src/**/*.test.ts']`. `package.json` already exports `./collector` from
`dist/{esm,cjs}/collector/index.js`. `src/collector/` holds only the scaffold: `index.ts` exports
`type CollectorPlaceholder = ArgusAgentPlaceholder` and `index.test.ts` checks it. `src/agent/index.ts`
exports `type AgentSample` from `sampler-controller.ts`:
`{ timestamp; eventLoop: { min, max, mean, p50, p99 }; memory: { heapUsed, heapTotal, rss, external, arrayBuffers }; gc: { count, totalPause, maxPause, kinds }; backpressure: { events, totalStall, maxStall, hotspots } }`,
all integers. `tsconfig.base.json` is strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. `eslint.config.mjs` restricts imports only for `src/agent/**`; the collector may
import `../agent/index.js`. The agent's samplers use a local `toNonNegativeInt` helper with saturation at
`Number.MAX_SAFE_INTEGER`; the collector mirrors that style.

Design (each file one axis of change):

1. **Window math** (`src/collector/window.ts`, new). Pure, stream-free.
   - Type `AggregatedWindow = { start: number; end: number; count: number; late: number; eventLoop: { max: number; p99: number; mean: number }; memory: { heapUsedLast: number; heapUsedMax: number; rssLast: number; rssMax: number }; gc: { count: number; totalPause: number; maxPause: number }; backpressure: { events: number; totalStall: number; maxStall: number } }`
     (units as the agent's: nanoseconds for lag and stalls, bytes for memory).
   - An internal accumulator `{ start, count, late, eventLoopMax, eventLoopP99Max, eventLoopMeanSum, heapUsedLast, heapUsedMax, rssLast, rssMax, gcCount, gcTotalPause, gcMaxPause, bpEvents, bpTotalStall, bpMaxStall }`.
   - `windowStartOf(timestamp, windowMs)` = `Math.floor(timestamp / windowMs) * windowMs` (both integers).
   - `openWindow(start)`, `addSample(acc, sample)` (maxima with `Math.max`, sums with a saturating integer
     add, last values overwritten; every input passed through `toNonNegativeInt`, which truncates, clamps
     negatives and NaN to 0 and caps at `Number.MAX_SAFE_INTEGER`), `closeWindow(acc, windowMs)` →
     `AggregatedWindow` with `end = start + windowMs` and
     `eventLoop.mean = count === 0 ? 0 : Math.floor(eventLoopMeanSum / count)`. No float leaves this file.
2. **Window aggregator** (`src/collector/window-aggregator.ts`, new).
   `createWindowAggregator({ windowMs }): Transform` — a `node:stream` `Transform` with
   `objectMode: true` (readable and writable). `windowMs` must be a positive safe integer, else
   `RangeError`. State: the open accumulator (or none) and nothing else.
   - `transform(sample)`: if `sample.timestamp` is not a finite number → `callback(new TypeError(…))`
     (surfaced, never swallowed). `start = windowStartOf(ts)`. No open window → open one at `start`. If
     `start === open.start` → `addSample`. If `start > open.start` → push `closeWindow(open)`, open a new
     window at `start` (a gap opens the later window directly; no empty windows), `addSample`. If
     `ts < open.start` → `open.late += 1` and drop it (a closed window is never re-opened).
   - `flush()`: push the open window if one exists.
   - Any exception thrown by the math is caught and passed to `callback(err)`.
3. **Ring buffer** (`src/collector/ring-buffer.ts`, new). Generic
   `createRingBuffer<T>(capacity): RingBuffer<T>` with `push(item): void`, `snapshot(): T[]` (a fresh array,
   oldest first, newest last), `readonly capacity` and `size(): number`. Backed by one pre-sized array plus a
   head index and a size; at capacity the oldest slot is overwritten, so memory stays bounded by `capacity`.
   `capacity` must be a positive safe integer, else `RangeError`.
4. **Collector** (`src/collector/collector.ts`, new).
   `createCollector({ windowMs, capacity }): Collector` where
   `Collector = { readonly windows: RingBuffer<AggregatedWindow>; consume(source: Readable | AsyncIterable<AgentSample>): Promise<void> }`.
   Options are validated eagerly (the aggregator and ring buffer `RangeError`s). `consume` builds a fresh
   aggregator and runs `await pipeline(source, aggregator, async function (windows) { for await (const w of windows) ring.push(w as AggregatedWindow); })`
   from `node:stream/promises` — never `.pipe()`. The returned promise resolves when the source ends and the
   last window is in the ring buffer, and rejects with the first error of any stage (a source error, an
   invalid sample). No `.catch` swallows it.
5. **Entrypoint** (`src/collector/index.ts`, modified). Exports `createWindowAggregator`, `createRingBuffer`,
   `createCollector` and the types `AggregatedWindow`, `WindowAggregatorOptions`, `RingBuffer`, `Collector`,
   `CollectorOptions`. It keeps the existing `CollectorPlaceholder` type export so the scaffold test
   `src/collector/index.test.ts` stays green and untouched (the SPEC allows, not requires, removing it).

Constraints held by construction: only `node:stream`, `node:stream/promises` and relative imports (the agent
via `../agent/index.js`, types only); `src/agent` is not touched; integer-only aggregation via truncation,
saturating adds and floor division; bounded ring buffer; no dependency, config, script or test-infra file is
touched.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there
  are no lessons to apply.

## Steps

- Add `src/collector/window.ts` with `AggregatedWindow`, the accumulator, `windowStartOf`, `openWindow`,
  `addSample` and `closeWindow`.
- Add `src/collector/window-aggregator.ts` with `createWindowAggregator` and `WindowAggregatorOptions`.
- Add `src/collector/ring-buffer.ts` with `createRingBuffer` and `RingBuffer`.
- Add `src/collector/collector.ts` with `createCollector`, `Collector` and `CollectorOptions`.
- Update `src/collector/index.ts` to re-export the above, keeping `CollectorPlaceholder`.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`; run
  prettier on the written files.

## Files

- `src/collector/window.ts` — new. `AggregatedWindow` type and the pure integer window math (start
  alignment, per-sample accumulate, close to a window object).
- `src/collector/window-aggregator.ts` — new. `createWindowAggregator({ windowMs })`: object-mode Transform
  that closes windows on a later sample or on end and counts late samples.
- `src/collector/ring-buffer.ts` — new. `createRingBuffer<T>(capacity)`: bounded, newest-last snapshot.
- `src/collector/collector.ts` — new. `createCollector({ windowMs, capacity })`: `consume(source)` runs
  `pipeline()` into the ring buffer and returns the completion promise; exposes `windows`.
- `src/collector/index.ts` — modified. Re-exports the factories and types; keeps `CollectorPlaceholder`.

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC; only its `AgentSample` type is imported.
- `src/collector/index.test.ts` — the scaffold test; it stays valid because `CollectorPlaceholder` remains.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (windowMs 1000; samples 1000, 1400, 1999 then 2500 then end → two windows): 1000/1400/1999 all map
  to start 1000 and accumulate; 2500 maps to 2000 > 1000, so the 1000 window is pushed before the 2500 sample's
  callback returns (count 3, max of maxes, max of p99s, `floor(32/3) = 10`, last heapUsed/rss from 1999 and
  their maxima, summed GC/backpressure counts and totals with max of single maxima, `late` 0, end 2000). `flush`
  pushes the 2000 window (end 3000, count 1). Every field comes out of `closeWindow`, so all are integers.
- **AC-2** (1500, 2100, then 1200 and 900, then 2200 and 3100, end): 1500 opens 1000; 2100 emits it and opens
  2000; 1200 and 900 are `< 2000`, so `late` becomes 2 and they are dropped (no second 1000 window and no 0
  window can be created, because only `start > open.start` opens a window); 2200 adds to 2000 (count 2); 3100
  emits the 2000 window with `late` 2 and opens 3000, flushed on end with `late` 0.
- **AC-3** (collector windowMs 1000, capacity 2, source over windows 0, 1000, 2000, 3000): `consume` resolves
  after the flush; four windows are pushed and the ring buffer keeps the last two, so `windows.snapshot()`
  starts are `[2000, 3000]`. A source that errors makes `pipeline()` reject with that error, which `consume`
  returns unchanged.

## Risks & open questions

- **Exported names and window field names** (`createWindowAggregator`, `createRingBuffer`, `createCollector`,
  `consume`, `windows.snapshot()`, `eventLoop.{max,p99,mean}`, `memory.{heapUsedLast,heapUsedMax,rssLast,rssMax}`,
  `gc.{count,totalPause,maxPause}`, `backpressure.{events,totalStall,maxStall}`, `start`, `end`, `count`,
  `late`) are this plan's choices; the SPEC left them open. The AC tests drive exactly these. Flagged for
  `/pharn-grill`.
- **Emission timing in AC-1.** "Emitted once the 2500 sample is written" holds because `push` happens inside
  that sample's `transform`; a test should observe it with a `data` listener or `read()` after the write
  callback, not rely on microtask ordering beyond that.
- **Non-integer input.** The agent only emits integers, but `toNonNegativeInt` truncates any float so an emitted
  window is always integral. A non-finite `timestamp` errors the stream rather than being dropped; the SPEC did
  not cover malformed samples, so this is a plan choice.
- **Placeholder kept.** The SPEC's Intent says this slice replaces the placeholder, its Assumptions say it may be
  removed. The plan keeps the type export to leave the existing scaffold test untouched; removing both is a
  trivial later cleanup.
- **`CLAUDE.md` is stale** (monorepo / pre-scaffold text vs. the live single package); out of scope.
