---
spec_id: agent-entry
spec_content_hash: f9fb4eb821cf3236522db36cfc728ad3330b322e01616d51e01c36837931e91e
applied_lessons: none
---

## Approach

> ADVISORY — model work, derived from the Approved SPEC `agent-entry` (`spec_kind: quick`).

Keep `src/agent/index.ts` a side-effect-free library entry: the existing in-process tests import it under vitest,
and making it start the agent on import would make every test worker stream samples to stdout. Add a new
auto-start entry, `src/agent/auto.ts`, which re-exports everything from `./index.js` and then calls
`startAgentOnce()`. Point the package's `./agent` export (both `import` and `require` conditions, `types` and
`default`) at `dist/{esm,cjs}/agent/auto.{js,d.ts}`. The existing build (`scripts/build.mjs`, both tsconfigs
already include `src/**/*.ts`) emits the new files with no build change.

`startAgentOnce()` lives in `src/agent/auto-start.ts`:

1. **Exactly-once guard:** `const AGENT_KEY = Symbol.for('argus.agent')`. If `globalThis[AGENT_KEY]` is already
   set, return; otherwise set it before anything else. The ESM and CJS copies of the module are two instances
   but share `globalThis` and the `Symbol.for` registry, so `--require` + `require()` + `import()` start one
   agent.
2. **Async start, fully caught:** `void start().catch(reportOnce)`. Nothing is awaited at module top level, so
   the `require`/`import` returns synchronously and can never throw from the agent; the try/catch around the
   synchronous guard and the `.catch` cover every path, so there is no unhandled rejection.
3. `start()`: `config = await loadAgentConfig(process.cwd(), process.env)`. If `!config.enabled` or
   `config.output === 'none'`, return without opening anything (so `ARGUS_ENABLED=0` creates no file).
4. Open the destination via `openAgentOutput(config.output)` (`src/agent/agent-output.ts`): `'stdout'` →
   `process.stdout`; any other value (already an absolute path from the config loader) →
   `fs.createWriteStream(path, { flags: 'a' })`.
5. `exporter = createNdjsonExporter(destination, { queueBound: config.queueBound })`;
   `controller = createSamplerController((s) => exporter.export(s))`; `controller.start(config.intervalMs)`.
   The controller's timer is already `unref()`ed, so the agent never keeps the process alive.
6. Attach `exporter.done.then(undefined, (err) => { controller.stop(); reportOnce(err); })`. An output error
   (missing directory → the write stream's `error` → `pipeline()` rejects) therefore turns the agent off and is
   reported once. The agent never calls `exporter.stop()`, so `process.stdout` is never ended (exit-time flush
   is a SPEC non-goal).
7. `reportOnce(err)`: a module-level-flag-guarded single `process.stderr.write('[argus] agent disabled: ' +
   <message collapsed to one line> + '\n')`, itself wrapped in try/catch so reporting can never throw. One
   `[argus]`-prefixed line per process, no stack trace.

Node core imports only (`node:fs`, `node:stream` types); no `async_hooks`; strict TS, no `any`.

## Applied lessons

- none — the project has no memory-bank yet (`check-lessons-index.mjs --verdict` → `NO_CANON`).

## Steps

- Add `src/agent/agent-output.ts` exporting `openAgentOutput(output: string): Writable` (`'stdout'` →
  `process.stdout`; otherwise an append-mode `fs.createWriteStream`). Callers never pass `'none'`.
- Add `src/agent/auto-start.ts` exporting `startAgentOnce(): void` per Approach steps 1–7.
- Add `src/agent/auto.ts`: `export * from './index.js';` then import and call `startAgentOnce()`.
- Edit `package.json` `exports["./agent"]`: `import.types` → `./dist/esm/agent/auto.d.ts`, `import.default` →
  `./dist/esm/agent/auto.js`, `require.types` → `./dist/cjs/agent/auto.d.ts`, `require.default` →
  `./dist/cjs/agent/auto.js`. No other key in `package.json` changes (not `scripts`, not dependencies).
- Run `npm run build`, `npm run check:exports`, `npm run typecheck`, `npm run lint` and `npm test`.
  `check:exports` now loads the auto-start entry; with default config (stdout, 1000 ms, unref'd timer) the
  check process still exits on its own before the first tick.

## Files

- `src/agent/agent-output.ts` — new: open the configured NDJSON destination (`process.stdout` or an append-mode file stream)
- `src/agent/auto-start.ts` — new: `startAgentOnce()` — process-wide `Symbol.for('argus.agent')` guard, async config load, exporter + controller wiring, single `[argus]` stderr report, never throws or rejects
- `src/agent/auto.ts` — new: the `argus/agent` auto-start entry; re-exports `./index.js` and calls `startAgentOnce()`
- `package.json` — `exports["./agent"]` `import`/`require` `types`/`default` repointed to `dist/{esm,cjs}/agent/auto.*`; nothing else

### Explicitly not touched

- `src/agent/index.ts` — stays the side-effect-free library entry (re-exported by `auto.ts`)
- `src/agent/config.ts` — config schema and loader unchanged (SPEC non-goal)
- `src/agent/sampler-controller.ts` — unchanged (SPEC non-goal)
- `src/agent/ndjson-exporter.ts` — unchanged (SPEC non-goal)
- `scripts/build.mjs` — already builds every `src/**/*.ts` into both formats
- `scripts/check-exports.mjs` — unchanged; must keep passing
- `vitest.config.mts` — test infrastructure, pinned; not changed

## Acceptance mapping

- **AC-1** (preload via `--require` and `--import`, file and stdout output, clean exit, stdout not ended) →
  `auto.ts` is what `argus/agent` resolves to under both conditions; `auto-start.ts` loads config from the
  child's `cwd`/env, opens the file in append mode or uses `process.stdout`, and the unref'd controller timer
  lets the child exit 0 on its own; the agent never ends stdout, so the app's later `console.log` still prints.
  Each line is an `AgentSample` (`timestamp`, `eventLoop`, `memory`, `gc`, `backpressure`) encoded by the
  existing exporter.
- **AC-2** (library exports still present; one agent across `--require` + 2×`require()` + `import()`;
  `ARGUS_ENABLED=0` off) → `export * from './index.js'` keeps `loadAgentConfig`, `createSamplerController`,
  `createNdjsonExporter` on both module objects; the `Symbol.for('argus.agent')` guard on `globalThis` makes the
  second-to-fourth loads no-ops, so sample timestamps stay one interval apart; `enabled === false` returns before
  any stream is opened, so no file is created.
- **AC-3** (invalid config / unusable output → exit 0, app runs, exactly one `[argus]` stderr line, no
  rejection or stack) → config errors reject inside `start()` and output errors reject `exporter.done`; both reach
  `reportOnce`, which writes one collapsed `[argus] …` line and nothing else, under both `--require` and `--import`.

## Risks & open questions

- **Test build strategy (for `/pharn-test`):** following the repo's existing child-process tests
  (`src/agent/gc-events.ac3.integration.test.ts` compiles the agent with the installed `typescript` into a temp
  dir), each AC test should build a private copy of the package in a temp dir rather than run
  `scripts/build.mjs` (which `rm -rf`s the shared `dist/` and would race between parallel test files). Suggested
  shape: compile every non-test `src/agent/*.ts` with `tsc --ignoreConfig` twice — ESM (`NodeNext`) into
  `<tmp>/dist/esm/agent` and CJS (`--module CommonJS --moduleResolution Node10 --ignoreDeprecations 6.0`) into
  `<tmp>/dist/cjs/agent` — write the `{"type":"module"}` / `{"type":"commonjs"}` markers, and write
  `<tmp>/package.json` with `name: "argus"` and the **real** `package.json`'s `exports` copied verbatim, so the
  child's `argus/agent` resolves by self-reference through the actual wiring this feature changes. Compiling the
  whole directory (not a hard-coded `auto.ts`) keeps the red run honest: before the build, `./agent` still points
  at `index.js`, which loads but starts nothing.
- The child env must contain no `ARGUS_*` variable other than the ones a test sets: the config loader rejects
  unknown `ARGUS_*` names, which would turn a run into an AC-3-style config error.
- AC-1's stdout ordering: samples are written asynchronously through `pipeline()`; the app's last
  `console.log` comes after its busy period, and the unref'd timer cannot fire once the loop empties. On macOS,
  pipe writes to stdout are asynchronous, so the test should assert on the full captured stdout (sample lines
  present, app line present and last) rather than on interleaving within a tick.
- `npm run check:exports` now executes the auto-start entry (stdout output at 1000 ms by default); it exits
  before the first sample. If a future default interval becomes shorter, its output could gain sample lines;
  harmless to its pass/fail.
- `package.json` is in `## Files` only for the `exports` repoint: `check-ac-tests.mjs` prints an advisory NOTE for
  it; the build must not touch `scripts`, the `jest` key or anything the test-infrastructure pin reads.
- Dual-package hazard is accepted: CJS and ESM consumers get distinct library module instances; only the
  auto-start is deduplicated, via `globalThis`.
