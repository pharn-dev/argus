---
spec_id: agent-backpressure-probes
spec_content_hash: 063a575a3ae94498260e9cd7179435f94571a8577b8235252678cac1f309d6dd
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `agent-backpressure-probes` (ROADMAP S1,
> slice 5).

Discovery (live, this run): the agent lives in `src/agent/` of a single npm package (`"type": "module"`,
dual ESM/CJS build via `scripts/build.mjs`, vitest with `include: ['src/**/*.test.ts']`). The pattern to
mirror is `src/agent/gc-sampler.ts`: `createGcSampler(): { enable(); disable(); sample() }`, `enable()`
resets the window and is idempotent, `disable()` is idempotent, `sample()` reads then resets, a local
`toNonNegativeInt` helper, saturating integer adds clamped at `Number.MAX_SAFE_INTEGER`.
`src/agent/sampler-controller.ts` owns the event loop and GC samplers, builds
`AgentSample = { timestamp, eventLoop, memory, gc }` on an unref'd `setInterval`, and `stop()` is a no-op
when idle. `src/agent/ndjson-exporter.ts` drives its destination with `pipeline(source(), destination)`, so
Node internals call `destination.write()`. `eslint.config.mjs` limits `src/agent/**/*.ts` (non-test) to
`node:` builtins and the agent's own files. Live Node is `v24.13.1`. No test asserts the exact key set of
`AgentSample`, so adding a required field is safe.

Design:

1. **Exclusion marker** (`src/agent/backpressure-exclusion.ts`, new). A module-level `WeakSet<Writable>`
   with `excludeFromBackpressure(stream: Writable): void` and
   `isExcludedFromBackpressure(stream: Writable): boolean`. Its own file so the exporter imports only the
   marker, not the probe. Not re-exported from the entrypoint (internal).
2. **Stack site parser** (`src/agent/stack-site.ts`, new). A pure function
   `siteFromStack(stack: string, skipFiles: ReadonlySet<string>): string | undefined`. It walks the frames
   after the first line, extracts the location from `at fn (loc)` or `at loc`, turns a `file://` URL into a
   path with `node:url` `fileURLToPath`, and skips frames whose location starts with `node:` or `internal/`,
   is `native`/`<anonymous>`, or whose file is in `skipFiles`. It returns `file:line` (the column dropped)
   for the first remaining frame, or `undefined`.
3. **Backpressure probe** (`src/agent/backpressure-probe.ts`, new).
   - Types: `BackpressureHotspot = { site: string; events: number; totalStall: number; maxStall: number }`;
     `BackpressureSample = { events: number; totalStall: number; maxStall: number; hotspots: BackpressureHotspot[] }`
     (stall times in integer nanoseconds, documented in a doc comment);
     `BackpressureProbeOptions = { maxHotspots?: number }`;
     `BackpressureProbe = { enable(): void; disable(): void; sample(): BackpressureSample }`.
   - `createBackpressureProbe(options = {})`: `maxHotspots` defaults to **10** and must be a positive safe
     integer, else `RangeError` (same style as the controller's interval check).
   - **One shared prototype wrap** (module level). `Writable` comes from `node:stream`. On the first probe
     `enable()` the module captures `original = Writable.prototype.write` and installs one `patchedWrite`.
     `patchedWrite` calls `Reflect.apply(original, this, args)`, returns that result unchanged, and only when
     it is `false` (and the stream is not excluded) notifies every enabled probe in a module-level `Set`.
     When the last enabled probe disables, the module restores `Writable.prototype.write = original` (the
     identical function), but only if the prototype still holds `patchedWrite`. Enabling twice is a no-op
     (the probe's `enabled` flag), and disabling twice is too.
   - **Site, once per stream.** A module-level `WeakMap<Writable, string>` caches each stream's site. On a
     stream's first stall only, the module captures a stack with `Error.captureStackTrace(holder, patchedWrite)`
     (so the wrapper and every frame above it are omitted), with `Error.stackTraceLimit` raised to 32 for that
     call and restored in `finally`. It calls `siteFromStack` with `skipFiles` = this module's own file (found
     once at load from a captured stack, which works under both ESM and CJS without `import.meta`), and falls
     back to `stream.constructor.name` (or `'Writable'`) when nothing remains or the capture throws. No stack is
     captured on any other `write()`.
   - **Stall timing per probe.** Each probe keeps a `WeakMap<Writable, bigint>` of open stall starts. On a
     `false` return for a stream with no open stall it records `process.hrtime.bigint()`, adds 1 to the window's
     `events` and to that site's `events`, and attaches `once('drain')` and `once('close')` listeners (each
     removes the other). A `false` while a stall is already open counts nothing. On `'drain'`:
     `duration = toNonNegativeInt(Number(now - start))` is added (saturating) to the current window's
     `totalStall` and the site's `totalStall`, and both `maxStall` values take `Math.max`. On `'close'` before
     `'drain'` the open stall is dropped with no duration. A listener that fires after its probe was disabled
     only clears its state. This is the SPEC assumption: the event counts in the window it started, the
     duration in the window it drains.
   - **Window.** `{ events, totalStall, maxStall, sites: Map<string, {events,totalStall,maxStall}> }`. At most
     256 distinct sites per window; later new sites fold into the site `'<other>'`, bounding memory.
     `enable()` resets the window. `sample()` builds the hotspots, sorted by `totalStall` desc, then `events`
     desc, then `site` asc (deterministic), sliced to `maxHotspots`, returns the sample and resets the window.
     An empty window gives zeros and `hotspots: []`. `disable()` leaves the window readable (as the GC sampler
     does).
4. **Exporter** (`src/agent/ndjson-exporter.ts`, modified): call `excludeFromBackpressure(destination)` at the
   top of `createNdjsonExporter`, before the pipeline starts.
5. **Controller** (`src/agent/sampler-controller.ts`, modified): `AgentSample` gains
   `backpressure: BackpressureSample`; the controller creates and owns one `createBackpressureProbe()`, enables
   it in `start` next to the other samplers, adds `backpressure: probe.sample()` each tick, and disables it in
   `stop` after `clearInterval`. The existing early return keeps a second `stop()` a no-op.
6. **Entrypoint** (`src/agent/index.ts`, modified): export `createBackpressureProbe` and the types
   `BackpressureSample`, `BackpressureHotspot`, `BackpressureProbe`, `BackpressureProbeOptions`.

Constraints held by construction: only `node:stream`, `node:url` and relative imports; no `async_hooks`;
every reported number passes through integer conversion (hrtime bigint differences, saturating adds); one
stack capture per stream; no runtime flag; no dependency, config, script or test-infra file is touched.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there
  are no lessons to apply.

## Steps

- Add `src/agent/backpressure-exclusion.ts` with the `WeakSet` marker and its two functions.
- Add `src/agent/stack-site.ts` with `siteFromStack`.
- Add `src/agent/backpressure-probe.ts` with the types, the shared prototype wrap and its restore, the
  per-stream site cache, the per-probe stall tracking and the read-then-reset `sample()`.
- In `src/agent/ndjson-exporter.ts`, mark the destination as excluded.
- In `src/agent/sampler-controller.ts`, add `backpressure` to `AgentSample` and own, enable, read and disable
  the probe.
- In `src/agent/index.ts`, re-export the probe and its types.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`.

## Files

- `src/agent/backpressure-exclusion.ts` — new. `WeakSet` marker: `excludeFromBackpressure`,
  `isExcludedFromBackpressure`.
- `src/agent/stack-site.ts` — new. `siteFromStack(stack, skipFiles)`: first non-internal, non-agent frame as
  `file:line`.
- `src/agent/backpressure-probe.ts` — new. `createBackpressureProbe`, its types, the shared
  `Writable.prototype.write` wrap with exact restore, per-window integer stall readings and top hotspots.
- `src/agent/ndjson-exporter.ts` — modified. Excludes its destination from the probe.
- `src/agent/sampler-controller.ts` — modified. `AgentSample` gains `backpressure`; the controller owns,
  enables, reads and disables the probe.
- `src/agent/index.ts` — modified. Re-exports `createBackpressureProbe` and its types.

### Explicitly not touched

- `src/agent/gc-sampler.ts`, `src/agent/event-loop-sampler.ts`, `src/agent/memory-sampler.ts` — reused as the
  shape to mirror; unchanged.
- `src/agent/ndjson-encoder.ts`, `src/agent/bounded-queue.ts`, `src/agent/config.ts`,
  `src/agent/config-schema.ts` — unchanged.
- Other features' tests under `src/agent/*.test.ts` — they read `AgentSample` by key and stay valid.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (enabled probe from the entrypoint; K stalls on a slow small-highWaterMark Writable; first read
  has `events === K`, integer total/max with max ≤ total, ≤ N hotspots sorted by total desc, the stream's
  entry naming the test file as `file:line`; second read empty; integration): each `false` return with no open
  stall counts one event; each `'drain'` adds its integer duration; `maxStall` is the largest single addend, so
  it is ≤ `totalStall`. The site is the first frame below `patchedWrite` that is neither Node-internal nor the
  probe's own file, i.e. the test file's `write()` call. `sample()` slices to `maxHotspots` and resets. Runs
  in-process in vitest so the stack names the test file (a child process would name a temp script).
- **AC-2** (enable twice, disable once, then `Writable.prototype.write === original`; a stall after disable
  is not counted; an exporter destination stall while enabled is never counted; unit): the probe's `enabled`
  flag makes the second `enable()` a no-op, so one `disable()` removes the only enabled probe and the module
  restores the captured original. After that, `write()` is the original and records nothing. The exporter
  marks its destination before its pipeline writes, and `patchedWrite` skips marked streams.
- **AC-3** (controller sample carries `backpressure` with events, total, max and hotspots, all non-negative
  integers, alongside `eventLoop`, `memory` and `gc`; after `stop()` the prototype is the original; unit): each
  tick adds `probe.sample()`; `stop()` disables the controller's probe, the last enabled one, which restores
  the original.

## Risks & open questions

- **Other stalls in the test worker.** AC-1 asserts `events` equals the test's stall count, so any other
  Writable in the vitest worker that stalls while the probe is enabled would break it. The AC-1 test should
  enable, stall, and read in one tight sequence and assert the stream's hotspot entry as well as the total.
  Flagged for `/pharn-test`.
- **Stack paths under vitest.** Vitest transforms TS; the frame file should be the test file's absolute path,
  but its line number may be the transformed one. AC-1 only needs `file:line` naming the test file, so the
  test should match the file name and a `:\d+` line, not an exact line.
- **Agent frames are skipped by file, not by directory.** The test files live in `src/agent/`, so excluding
  the whole agent directory would also hide the test's own frame. The plan skips the wrapper through
  `captureStackTrace`'s function argument plus the probe's own file. The exporter's writes are excluded by
  the marker, not by the stack.
- **Prototype shared across probes.** If other code replaces `Writable.prototype.write` after the probe
  wraps it, the probe does not clobber it on restore; then the identity check in AC-2/AC-3 would not hold.
  Nothing in this repo does that.
- **Subclasses that override `write`** (some Duplex/Transform internals, user classes) are not seen; the
  SPEC's in-scope mechanism is the single prototype wrap, so this is accepted.
- **Field names** (`events`, `totalStall`, `maxStall`, `hotspots[].site`), the default N = 10 and the
  256-site window bound are this plan's choices; the SPEC left them open. Flagged for `/pharn-grill`.
- **`CLAUDE.md` is stale** (monorepo / pre-scaffold text); out of scope, as noted in earlier slices.
