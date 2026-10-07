---
spec_id: plugin-runner-sandbox
spec_content_hash: 76472e01a4855b1dd01f7431f05eb385416f2c8115d1f75f35fe5c43e409e83d
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `plugin-runner-sandbox` (ROADMAP S6, slice 1).

Discovery (live, this run): single npm package (`"type": "module"`, dual build by `scripts/build.mjs`: ESM via
`tsconfig.esm.json` with `module: NodeNext`, CJS via `tsconfig.cjs.json` with `module: CommonJS` /
`moduleResolution: Node10`; both `include: ["src/**/*.ts"]` and exclude only `*.test.ts`). `tsconfig.base.json` is
strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. `src/plugin-runner/index.ts` holds only the
scaffold type `PluginRunnerPlaceholder` (used by `src/plugin-runner/index.test.ts`); the `./plugin-runner` exports
subpath already exists in `package.json`. `src/collector/index.ts` exports `type AggregatedWindow`
(`{ start, end, count, late, eventLoop: { max, p99, mean }, memory: {…}, gc: {…}, backpressure: {…} }`, all
integers). `package.json` has no `dependencies`, no `peerDependencies`; `isolated-vm` is not in `node_modules`.
`npm view` shows `isolated-vm@6.x` (latest 6.2.0) declares `engines.node >=22.0.0`, while 7.x needs Node 24, so the
range is `^6.1.0`. The repo's toolchain here is Node v22.19.0 (`.nvmrc` = `22`), which strips TypeScript types by
default, so a `.ts` child script can be forked directly in tests. No source file uses `import.meta` (the CJS build
compiles with `module: CommonJS`, where TypeScript rejects `import.meta`).

Design (each file one axis of change; `src/plugin-runner` imports Node core, `isolated-vm` (child only, loaded
dynamically) and `import type` from `../collector/index.js`; nothing in `src/agent` or `src/collector` changes):

1. **Result contract** (`src/plugin-runner/rule-result.ts`, new) — the public data shapes, nothing else.
   - `RuleErrorCode` — a frozen `as const` object, one stable string per failure kind:
     `RULE_THREW: 'ARGUS_RULE_THREW'`, `TIMEOUT: 'ARGUS_RULE_TIMEOUT'`, `MEMORY_LIMIT: 'ARGUS_RULE_MEMORY_LIMIT'`,
     `COMPILE_ERROR: 'ARGUS_RULE_COMPILE_ERROR'`, `ISOLATED_VM_MISSING: 'ARGUS_ISOLATED_VM_MISSING'`,
     `INVALID_RESULT: 'ARGUS_RULE_INVALID_RESULT'` (the rule returned something that is not a findings array),
     `SANDBOX_CRASHED: 'ARGUS_SANDBOX_CRASHED'` (the child exited or errored mid-run, or its script was not found),
     `RUNNER_CLOSED: 'ARGUS_RUNNER_CLOSED'` (run after or during `close()`). Type
     `RuleErrorCodeValue = (typeof RuleErrorCode)[keyof typeof RuleErrorCode]`.
   - `RuleFinding = { windowStart: number; message: string }` — a finding identifies its window by that window's
     `start` (the SPEC's "identifies the window"; `start` is unique per window in a collector ring).
   - `RuleRunResult = { ok: true; findings: RuleFinding[] } | { ok: false; error: { code: RuleErrorCodeValue;
     message: string } }` — plain JSON data, always.
   - `ruleFailure(code, message): RuleRunResult` helper and `parseFindings(value: unknown): RuleFinding[] | string`
     (returns the array when `value` is an array whose every item is a plain object with a safe-integer
     `windowStart` and a string `message`, copying only those two fields; else a string reason for
     `INVALID_RESULT`).
2. **IPC protocol types** (`src/plugin-runner/sandbox-protocol.ts`, new) — types only (no runtime code, so the child
   can `import type` it under Node's type stripping without a runtime `.ts` import):
   `RunRequest = { type: 'run'; id: number; source: string; windowsJson: string; timeoutMs: number; memoryLimitMb:
   number; isolatedVmModule: string }` and `RunReply = { type: 'result'; id: number; result: RuleRunResult }`.
3. **Sandbox child** (`src/plugin-runner/workers/sandbox-child.ts`, new) — the child-process entry, in the
   `*/workers/` directory the conventions require for out-of-thread entry files. Erasable TypeScript syntax only
   (no `enum`, no parameter properties, no runtime import of sibling `.ts` files — `import type` only), so the same
   file runs from source under type stripping and compiles to both builds.
   - `process.on('message', …)`: validates the message shape (own small guard; a malformed message is reported on
     `stderr` and ignored, never silently), handles one request at a time, and always answers with a `RunReply`
     via `process.send`. `process.on('disconnect', () => process.exit(0))` so the child never outlives its host.
   - Loading: `await import(request.isolatedVmModule)` once (memoised on success; a failure is not memoised), taking
     `mod.default ?? mod`. Any load error → `ARGUS_ISOLATED_VM_MISSING`, message: ``isolated-vm could not be loaded
     (<specifier>: <cause>). argus/plugin-runner needs it: install it with `npm install isolated-vm` (an optional
     peer dependency of argus, 6.x).`` The CJS build compiles this `import()` to `require()`, which loads the native
     CJS module the same way.
   - Per run, a fresh `new ivm.Isolate({ memoryLimit: memoryLimitMb })` and context, disposed in `finally` unless
     already disposed. The rule source is wrapped as a function body:
     `"use strict"; const __argusRule = (function (windows) {\n<source>\n}); JSON.stringify(__argusRule(JSON.parse(__argusInput)));`
     with `__argusInput` set to `windowsJson` through `context.global.set` (a copied string; no host references
     enter the isolate, and no `require`, timers, filesystem or network exist inside it).
   - `isolate.compileScript(code)` throwing → `ARGUS_RULE_COMPILE_ERROR` with the error message.
     `script.run(context, { timeout: timeoutMs })` throwing → classify: `isolate.isDisposed` (memory-limit
     disposal) → `ARGUS_RULE_MEMORY_LIMIT`; message matching isolated-vm's `/timed out/i` **and** elapsed
     (`process.hrtime.bigint()`) ≥ `timeoutMs` → `ARGUS_RULE_TIMEOUT`; anything else → `ARGUS_RULE_THREW` with the
     thrown message (`String(error)` for a non-Error throw). A non-string run result (`undefined` from
     `JSON.stringify`) → `ARGUS_RULE_INVALID_RESULT`; otherwise `JSON.parse` then `parseFindings`.
   - The child also listens for `uncaughtException` / `unhandledRejection`: it writes the error to `stderr` and
     exits non-zero, which the host turns into `ARGUS_SANDBOX_CRASHED` (never a hang, never silent).
4. **Child script location** (`src/plugin-runner/child-script.ts`, new) — `resolveChildScript(): string | Error`.
   The module's own directory comes from `__dirname` when it is a string (CJS build, and Vitest, which defines it),
   else from the first stack frame of a local `new Error()` (an absolute path, or a `file://` URL converted with
   `fileURLToPath`) — this compiles in both builds without `import.meta`. It returns `workers/sandbox-child.js` when
   that file exists (the built `dist/esm` / `dist/cjs` trees), else `workers/sandbox-child.ts` (source, under Node's
   type stripping), else an `Error` naming both paths. Resolved lazily at the first run, so importing
   `argus/plugin-runner` (and `npm run check:exports`) never touches the filesystem.
5. **Sandbox process** (`src/plugin-runner/sandbox-process.ts`, new) — the host side of one child process,
   Node core only (`node:child_process`).
   - `createSandboxProcess(scriptPath: string)` → `{ request(req: Omit<RunRequest, 'type' | 'id'>, watchdogMs:
     number): Promise<RuleRunResult>; kill(): Promise<void> }`.
   - Lazily `fork(scriptPath, [], { execArgv: ['--no-node-snapshot'], serialization: 'json', stdio: ['ignore',
     'inherit', 'inherit', 'ipc'] })` — `execArgv` is set explicitly, so the host's own flags are never inherited
     and the host is never started with `--no-node-snapshot`. The host never imports `isolated-vm`.
   - One request in flight at a time (the runner serialises). Each request gets an integer id; the reply is matched
     by id (a reply with an unknown id or a bad shape is reported via `process.emitWarning` and ignored).
   - **Watchdog:** a host timer of `watchdogMs` (the runner passes `timeoutMs + 1000`); if it fires, the child is
     `SIGKILL`ed and the request resolves `ARGUS_RULE_TIMEOUT` (message says the sandbox did not answer in time).
   - **Child failure:** `'error'` (spawn failure) or `'exit'` while a request is pending resolves it with
     `ARGUS_SANDBOX_CRASHED` naming the exit code / signal; the dead child is dropped and the next request forks a
     new one. An `'error'` / `'exit'` with nothing pending is reported via `process.emitWarning` and the child is
     dropped. A `process.send` callback error is handled the same way. Every listener is attached before the first
     send; nothing rejects.
   - **Idle does not hold the host open:** while no request is pending the child and its IPC channel are
     `unref()`ed; they are `ref()`ed while a request is in flight.
   - `kill()`: resolves once the child has exited (or immediately if none), after `disconnect()` and a `SIGKILL`
     fallback timer; a pending request resolves `ARGUS_RUNNER_CLOSED`.
6. **Plugin runner** (`src/plugin-runner/plugin-runner.ts`, new) — the public factory.
   - `createPluginRunner(options?: PluginRunnerOptions): PluginRunner`, `PluginRunnerOptions = { timeoutMs?: number;
     memoryLimitMb?: number; isolatedVmModule?: string }`. Defaults `timeoutMs` 1000, `memoryLimitMb` 64,
     `isolatedVmModule` `'isolated-vm'`. Validation at creation (programmer errors, thrown synchronously as
     `RangeError`/`TypeError`): `timeoutMs` a positive safe integer; `memoryLimitMb` a safe integer ≥ 8
     (isolated-vm's minimum); `isolatedVmModule` a non-empty string. `isolatedVmModule` is the SPEC's test seam
     for AC-3 (documented as such in its TSDoc).
   - `PluginRunner = { run(source: string, windows: readonly AggregatedWindow[]): Promise<RuleRunResult>; close():
     Promise<void> }`. `run` never rejects: it chains onto an internal promise queue (one run at a time), checks
     `source` is a string (else `ARGUS_RULE_COMPILE_ERROR`), `JSON.stringify`s the windows (a throw resolves
     `ARGUS_RULE_INVALID_RESULT` with a message saying the input windows are not JSON-serialisable — see Risks),
     resolves the child script (an `Error` → `ARGUS_SANDBOX_CRASHED`), sends the request, and
     wraps the whole step in `try/catch` so any unexpected throw becomes `ARGUS_SANDBOX_CRASHED` with its message.
   - `close()` is idempotent (returns the same promise): marks the runner closed (later `run`s resolve
     `ARGUS_RUNNER_CLOSED`) and calls the sandbox process's `kill()`.
7. **Entrypoint** (`src/plugin-runner/index.ts`, modified) — exports `createPluginRunner`, `RuleErrorCode`, and the
   types `PluginRunner`, `PluginRunnerOptions`, `RuleRunResult`, `RuleFinding`, `RuleErrorCodeValue`; keeps
   `PluginRunnerPlaceholder` so the scaffold test stays valid.
8. **Package manifest** (`package.json`, `package-lock.json`, modified) — `devDependencies.isolated-vm: "^6.1.0"`,
   `peerDependencies.isolated-vm: "^6.1.0"`, `peerDependenciesMeta.isolated-vm: { "optional": true }`; still no
   `dependencies`. The lockfile is updated by `npm install --save-dev isolated-vm@^6.1.0` (then the peer fields are
   added by hand with the Edit tool and `npm install` re-run so the lock agrees). No `scripts`, `exports`, `jest` or
   `engines` change.

Constraints held by construction: the agent is untouched; host code uses only `node:` builtins and
`import type` from the collector; `isolated-vm` is reached only by the child's dynamic import; no `.pipe()`;
counters (`id`) change only by `+= 1`; every child `'error'`/`'exit'`/send failure and every rule outcome resolves
a typed result or is reported via `process.emitWarning`; nothing rejects from `run`.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- `npm install --save-dev isolated-vm@^6.1.0` (Node 22 toolchain), then add `peerDependencies` and
  `peerDependenciesMeta` for `isolated-vm` to `package.json` and re-run `npm install` so `package-lock.json` agrees.
- Add `src/plugin-runner/rule-result.ts` and `src/plugin-runner/sandbox-protocol.ts`.
- Add `src/plugin-runner/workers/sandbox-child.ts`.
- Add `src/plugin-runner/child-script.ts` and `src/plugin-runner/sandbox-process.ts`.
- Add `src/plugin-runner/plugin-runner.ts`; update `src/plugin-runner/index.ts`.
- Run `npx prettier --write` on each written file, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build`, `npm run check:exports`, and confirm `dist/esm/plugin-runner/workers/sandbox-child.js` and
  `dist/cjs/plugin-runner/workers/sandbox-child.js` exist.

## Files

- `src/plugin-runner/rule-result.ts` — new. `RuleErrorCode`, `RuleErrorCodeValue`, `RuleFinding`, `RuleRunResult`,
  `ruleFailure`, `parseFindings`.
- `src/plugin-runner/sandbox-protocol.ts` — new. Type-only IPC messages `RunRequest` / `RunReply`.
- `src/plugin-runner/workers/sandbox-child.ts` — new. Child entry: loads `isolated-vm` by specifier, runs one rule
  per fresh isolate with memory limit and timeout, classifies failures, replies over IPC.
- `src/plugin-runner/child-script.ts` — new. `resolveChildScript()` without `import.meta` (`.js` built, `.ts`
  source).
- `src/plugin-runner/sandbox-process.ts` — new. Forks the child with `execArgv: ['--no-node-snapshot']`, request /
  reply by id, watchdog kill, crash and exit handling, ref/unref, `kill()`.
- `src/plugin-runner/plugin-runner.ts` — new. `createPluginRunner`: option validation, serial queue, never-rejecting
  `run`, idempotent `close`.
- `src/plugin-runner/index.ts` — modified. Public exports; keeps `PluginRunnerPlaceholder`.
- `package.json` — modified. `isolated-vm` `^6.1.0` as devDependency and optional peer dependency only.
- `package-lock.json` — modified. Lock entries for `isolated-vm` 6.x (via `npm install`).

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC; nothing there imports the plugin runner.
- `src/collector/**` — reused through `import type { AggregatedWindow }` only.
- `src/plugin-runner/index.test.ts` — existing scaffold test; must keep passing unchanged.
- `vitest.config.mts`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`, `eslint.config.mjs`,
  `scripts/build.mjs`, `scripts/check-exports.mjs` — build and test infrastructure; the `./plugin-runner` export
  subpath already exists and the child file is emitted by the existing `src/**/*.ts` include.

## Acceptance mapping

- **AC-1** (runner from `argus/plugin-runner` with `isolated-vm` installed; rule returning a finding for each window
  with `eventLoop.max > 100`; three windows with max 50, 500, 50): the rule body receives the JSON-copied windows,
  returns `[{ windowStart: windows[1].start, message }]`; the child stringifies it, the host validates it with
  `parseFindings`, and `run` resolves `{ ok: true, findings: [ … ] }` with one finding whose `windowStart` is the
  second window's `start` — plain data, so `JSON.parse(JSON.stringify(result))` deep-equals it.
- **AC-2** (`timeoutMs: 200`, `memoryLimitMb: 16`, host `setInterval` 10ms; throw / infinite loop / unbounded
  allocation / syntax error, then the AC-1 rule): `throw new Error('boom')` → `ARGUS_RULE_THREW` with `boom` in the
  message; `while (true) {}` → isolated-vm's timeout at 200ms → `ARGUS_RULE_TIMEOUT` (host watchdog at 1200ms as a
  backstop), well inside 2000ms, and the host interval keeps ticking because the loop runs in the child process;
  unbounded allocation → isolate disposed at 16MB → `ARGUS_RULE_MEMORY_LIMIT`; invalid source → `compileScript`
  throws → `ARGUS_RULE_COMPILE_ERROR`. Each run uses a fresh isolate (and a crashed or killed child is re-forked),
  so the fifth run resolves `{ ok: true }`. No path rejects.
- **AC-3** (sandbox child cannot load `isolated-vm`): the test passes `isolatedVmModule` naming a specifier that does
  not resolve; the child's dynamic import fails, and `run` resolves `{ ok: false, error: { code:
  'ARGUS_ISOLATED_VM_MISSING', message } }` whose message names `isolated-vm` and `npm install isolated-vm`; the
  host only exchanged IPC messages, so it is still running.

## Risks & open questions

- **Names and codes are plan choices** (`createPluginRunner`, options `timeoutMs`, `memoryLimitMb`,
  `isolatedVmModule`; `run(source, windows)`, `close()`; result `{ ok, findings }` / `{ ok, error: { code,
  message } }`; finding `{ windowStart, message }`; codes `ARGUS_RULE_THREW`, `ARGUS_RULE_TIMEOUT`,
  `ARGUS_RULE_MEMORY_LIMIT`, `ARGUS_RULE_COMPILE_ERROR`, `ARGUS_ISOLATED_VM_MISSING`, plus `ARGUS_RULE_INVALID_RESULT`,
  `ARGUS_SANDBOX_CRASHED`, `ARGUS_RUNNER_CLOSED` for the explicit-handling cases the Constraints require). The AC
  tests drive exactly these, and assert codes through the exported `RuleErrorCode` constant.
- **Unserialisable input windows** (step 6): a `JSON.stringify` throw on the host resolves
  `ARGUS_RULE_INVALID_RESULT` with a message about the input — the build must not invent another code; flagged for
  `/pharn-grill` in case a separate input code is preferred.
- **Running the `.ts` child from source in tests** relies on Node's default type stripping (Node ≥ 22.18; this
  toolchain is 22.19.0). On an older 22.x the source child would fail to start and every test run would resolve
  `ARGUS_SANDBOX_CRASHED`; the built `.js` child is unaffected. The child must stay erasable-syntax-only.
- **Own-directory lookup** relies on `__dirname` (CJS, Vitest) or the stack-trace fallback (plain ESM); a bundler
  that rewrites both would make `resolveChildScript` return its `Error`, surfacing as `ARGUS_SANDBOX_CRASHED` with
  the searched paths named — never a crash. A `childScript` option is deliberately not added (no triggering failure,
  P7).
- **Memory-limit behaviour** is isolated-vm's: on exceeding `memoryLimit` it disposes the isolate and throws. If on
  some platform the child process itself dies instead, AC-2's memory case would read `ARGUS_SANDBOX_CRASHED`; the
  test stage's red run and the build will show it.
- **`isolated-vm` is a native module** built at install time (prebuilds exist for common platforms); a host where it
  fails to build or install is exactly AC-3's path.
- **Timeout classification** checks both isolated-vm's message and elapsed time ≥ `timeoutMs`, so a rule throwing an
  error whose text says "timed out" early is still `ARGUS_RULE_THREW`.
