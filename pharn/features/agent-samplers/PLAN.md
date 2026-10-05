---
spec_id: agent-samplers
spec_content_hash: 4de3b7fa138e2b3380e9c01fed10064b5806a55c77d86825ba43f2184dfd64ad
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `agent-samplers` (ROADMAP S1, first slice).

Discovery (live, this run): the repo is a **single npm package**, not the pnpm monorepo that `CLAUDE.md`
describes. Modules live under `src/<module>/`, build to `dist/esm` and `dist/cjs` through `scripts/build.mjs`
(`tsconfig.esm.json` / `tsconfig.cjs.json`, both `include: src/**/*.ts`, excluding `*.test.ts`), and are
exported as `argus/agent` and so on. `vitest.config.mts` collects `src/**/*.test.ts`. `eslint.config.mjs`
already restricts `src/agent/**/*.ts` (tests excluded) to `node:` builtins and relative imports. The agent
entrypoint `src/agent/index.ts` is currently a placeholder type, `ArgusAgentPlaceholder`, and
`src/collector/index.ts` imports that type, so it **must stay exported**. The plan follows the live layout and
the SPEC's own path (`src/agent/index.ts`). The stale `CLAUDE.md` text is noted under Risks; this feature
does not edit it.

Three small modules, one reason to change each, plus re-exports from the entrypoint:

1. **Event loop lag sampler** (`src/agent/event-loop-sampler.ts`) wraps one
   `perf_hooks.monitorEventLoopDelay()` histogram (`node:perf_hooks`, default resolution).
   - `createEventLoopSampler(): EventLoopSampler`, where
     `EventLoopSampler = { enable(): void; disable(): void; sample(): EventLoopSample }`.
   - `EventLoopSample = { min: number; max: number; mean: number; p50: number; p99: number }`, all integer
     nanoseconds.
   - `sample()` reads `min`, `max`, `mean`, `percentile(50)` and `percentile(99)`, then calls
     `histogram.reset()` so the next window starts fresh.
   - Integer and non-negative guarantees:
     - `mean` goes through `Math.round`, as the SPEC assumes.
     - When `histogram.count === 0` (an empty window), every field is `0`. An empty histogram reports `min` as
       a huge sentinel and `mean` as `NaN`, and neither is a valid integer reading.
     - Every value is passed through one small local `toNonNegativeInt` helper (round, clamp to
       `[0, Number.MAX_SAFE_INTEGER]`, NaN → 0) so no float or sentinel leaks into a sample.
2. **Memory sampler** (`src/agent/memory-sampler.ts`) exports `sampleMemory(): MemorySample`, where
   `MemorySample = { heapUsed; heapTotal; rss; external; arrayBuffers }` are integer bytes read from
   `process.memoryUsage()` (the `node:process` import). Each value goes through `Math.trunc` defensively.
   They are already integers, but the SPEC's "no floats" constraint is cheap to make structural.
3. **Sampler controller** (`src/agent/sampler-controller.ts`) exports
   `createSamplerController(onSample: (sample: AgentSample) => void): SamplerController`, where
   `SamplerController = { start(intervalMs: number): void; stop(): void }` and
   `AgentSample = { timestamp: number; eventLoop: EventLoopSample; memory: MemorySample }`.
   - `start(intervalMs)` validates `intervalMs` (a positive safe integer, otherwise it throws a `RangeError`:
     an explicit failure, never a silent one). On the first call it enables the histogram and creates one
     `setInterval`, then calls `.unref()` on it so it never keeps the process alive.
   - Each tick calls `onSample({ timestamp: Date.now(), eventLoop: elSampler.sample(), memory: sampleMemory() })`.
     `Date.now()` is already an integer number of milliseconds.
   - A second `start` while running is a **no-op**. It is idempotent, so the interval of the first call
     stays. Only one timer can exist, so samples arrive at most once per interval.
   - `stop()` calls `clearInterval`, disables the histogram and marks the controller stopped. A tick cannot
     run after `clearInterval` returns, so no sample arrives after `stop` returns. `stop()` on a never-started
     or already-stopped controller is a harmless no-op, as the SPEC assumes. A controller may be started again
     after `stop`; `start` re-enables the histogram.
   - The callback runs synchronously inside the tick. An exception it throws is **not** caught. It surfaces
     as the process's `uncaughtException`, exactly as for any user timer. That keeps the "no swallowed
     failures" convention, and the agent adds no error policy the SPEC did not approve (see Risks).
4. **Entrypoint** (`src/agent/index.ts`) keeps `ArgusAgentPlaceholder` and adds the re-exports:
   `createSamplerController`, `createEventLoopSampler`, `sampleMemory` and the `type` exports
   `AgentSample`, `EventLoopSample`, `MemorySample`, `SamplerController` and `EventLoopSampler`.
   Relative specifiers carry the `.js` suffix, as `NodeNext` requires and as the CJS build already handles.

Constraints held by construction:

- The imports are only `node:perf_hooks` and `node:process`, plus relative files. This satisfies the eslint
  agent boundary rule.
- There is no `async_hooks` import.
- Every number goes through integer conversion.
- No new dependency is added, and no config, script or test-infra file is touched.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`, and
  `memory-bank/lessons-learned.md` does not exist), so there are no lessons to apply.

## Steps

- Add `src/agent/event-loop-sampler.ts` with `createEventLoopSampler`, the `EventLoopSample` and
  `EventLoopSampler` types and the local integer-clamp helper. `sample()` reads the window and then resets the
  histogram. An empty window yields all zeros.
- Add `src/agent/memory-sampler.ts` with `sampleMemory` and `MemorySample`.
- Add `src/agent/sampler-controller.ts` with `createSamplerController`, `AgentSample` and `SamplerController`:
  a validated `start` with an idempotent guard, an unref'd `setInterval`, and a `stop` that clears the timer and
  disables the histogram, with a no-op when idle.
- Update `src/agent/index.ts` to re-export the above. Keep `ArgusAgentPlaceholder`, which
  `src/collector/index.ts` imports.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`. The ESM and
  CJS builds must keep compiling, and `argus/agent` must load in both formats.

## Files

- `src/agent/event-loop-sampler.ts`: new. A `monitorEventLoopDelay`-backed sampler that emits integer-ns
  min/max/mean/p50/p99 and resets the histogram per window.
- `src/agent/memory-sampler.ts`: new. `process.memoryUsage()` turned into integer-byte heapUsed, heapTotal,
  rss, external and arrayBuffers.
- `src/agent/sampler-controller.ts`: new. `createSamplerController(onSample)` with `start(intervalMs)` and
  `stop()`, an unref'd timer and idempotent start.
- `src/agent/index.ts`: modified. Re-exports the samplers, the controller and their types, and keeps
  `ArgusAgentPlaceholder`.

### Explicitly not touched

- `src/agent/index.test.ts`: the existing scaffold test, left as is.
- `src/collector/index.ts`: still imports `ArgusAgentPlaceholder`, which stays exported.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs`: test and build infrastructure, out of scope.
- `CLAUDE.md`: stale monorepo description, flagged under Risks and not edited here.

## Acceptance mapping

- **AC-1** (one sample, integer ms timestamp, integer non-negative ns event-loop fields, integer non-negative
  byte memory fields; unit): `createSamplerController` from `src/agent/index.ts` emits
  `{ timestamp: Date.now(), eventLoop, memory }`. Every field goes through integer conversion and is clamped to
  be non-negative. An empty window gives zeros, not NaN or a sentinel. The test is in AC-TESTS.md.
- **AC-2** (a blocked window reports max ≥ 50 ms in ns, and the next, unblocked window reports a lower max;
  unit): `sample()` calls `histogram.reset()` after every read, so each emitted sample covers only its own
  interval. A busy-wait of about 100 ms inside one interval raises that window's `max` to about 1e8 ns. The
  next window's `max` stays near the histogram resolution, about 1e7 ns. The test picks an interval (about
  200–300 ms) that leaves room for the block.
- **AC-3** (a double `start` then `stop`: at most one sample per interval and none after `stop`; a separate
  process that only starts the controller exits 0 on its own; integration):
  - The idempotent guard means there is a single timer.
  - `clearInterval` inside `stop` means no tick runs after it returns.
  - `.unref()` on the timer and the histogram's own unref'd sampling mean the child process exits when its
    main script ends.

## Risks & open questions

- **The AC-3 child process must load the agent.** The child cannot import `src/agent/*.ts` directly. Node's
  type stripping does not rewrite the `.js` relative specifiers that `NodeNext` source uses. `/pharn-test`
  must choose a loader that needs no new dependency and no test-infra change, for example:
  - compile `src/agent` with the installed `typescript` (`node node_modules/typescript/bin/tsc`) into a
    temporary directory with a `{ "type": "module" }` `package.json`, then spawn `process.execPath` on a
    script that imports it; or
  - run against `dist/` only after an explicit build in the test's setup.

  `vitest.config.mts` and `package.json` scripts must stay unchanged, since the lock pins them.
- **Timing flakiness (AC-2, AC-3).** The SPEC's 100 ms block and 50 ms threshold are already chosen to tolerate
  a loaded CI machine. The tests should use generous intervals and assert on bounds ("at most N samples"), never
  on exact counts.
- **Callback exceptions are not caught** (advisory design choice). The SPEC is silent on this. Catching and
  dropping would violate the "no silent failures" convention. Catching and re-routing would need an error
  channel the SPEC did not approve (P7). Flagged for `/pharn-grill`.
- **`start` with a different interval while running** is ignored, not re-armed, which is a literal reading of
  "idempotent". Flagged so a later config slice can revisit it.
- **`CLAUDE.md` is stale.** It describes a pnpm monorepo, `packages/` and a pre-scaffold state. The live repo
  is a single npm package with `src/<module>/` (`ROADMAP.md` S0 agrees with the live repo). This is out of
  scope here; flagged for the human.
- **The agent has no benchmark yet.** `CLAUDE.md` asks for agent overhead to be benchmarked, but the SPEC has
  no criterion for it. It is not added here (P7) and is left for a later slice.
