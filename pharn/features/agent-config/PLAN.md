---
spec_id: agent-config
spec_content_hash: b62ddaedd1c83680c9c5120e7e8bd791a84cda3c03683263df20f589383bbdbb
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `agent-config` (ROADMAP S1, third slice).

Discovery (live, this run): the repo is a single npm package (`"type": "module"`, `engines.node >=22`,
`.nvmrc` `22`) with modules under `src/<module>/`. `scripts/build.mjs` compiles `src/**/*.ts` (tests
excluded) twice: `tsconfig.esm.json` (NodeNext, ESM) to `dist/esm` and `tsconfig.cjs.json` (`module:
CommonJS`) to `dist/cjs`. `vitest.config.mts` collects `src/**/*.test.ts`. `eslint.config.mjs` limits
non-test `src/agent/**/*.ts` to `node:` builtins and relative imports. `src/agent/index.ts` re-exports the
samplers, the controller, the NDJSON encoder and `createNdjsonExporter`, whose `queueBound` default is `1024`
(`DEFAULT_QUEUE_BOUND` in `src/agent/ndjson-exporter.ts`, positive safe integer, validated by
`createBoundedQueue`).

The slice adds one public async loader and splits its work by reason to change (P3):

1. **Shape, defaults and errors** (`src/agent/config-schema.ts`):
   - `type AgentConfig = Readonly<{ intervalMs: number; output: string; queueBound: number; enabled: boolean }>`.
     `output` is the string `'stdout'`, the string `'none'` (disabled), or an **absolute** file path.
   - `defaultAgentConfig: AgentConfig`, frozen: `intervalMs: 1000`, `output: 'stdout'`, `queueBound: 1024`
     (the exporter's existing default, so the two agree), `enabled: true`.
   - Bounds (integer, inclusive): `intervalMs` 1 to 3_600_000 (one hour); `queueBound` 1 to 1_000_000.
   - `class ArgusConfigError extends Error` with readonly `source: string` and `key: string | undefined`.
     Its message is `argus config: <source>[: <key>]: <reason>`, so the source name and the key are always
     in the message text (AC-3). `name` is `'ArgusConfigError'`; an underlying error (a JSON `SyntaxError`, a
     module load error) is passed as `cause`, never dropped.
   - `validateConfigValue(source, key, value: unknown)`: one validator per key, applied to an already-typed
     value. `intervalMs` / `queueBound`: `Number.isSafeInteger` and within bounds. `enabled`: a boolean.
     `output`: a non-empty string. Anything else throws `ArgusConfigError(source, key, …)`. File and env
     sources both end here, so the rules exist once.
2. **Config file source** (`src/agent/config-file.ts`): `readConfigFile(cwd): Promise<Partial<…>>`.
   - Looks only in `cwd` (no parent search). `stat` each of `argus.config.json` and `argus.config.js`;
     `ENOENT` means absent, any other `stat` error is rethrown wrapped as `ArgusConfigError` naming that file.
     Both present: throws an `ArgusConfigError` whose message contains both names. Neither present: returns
     `{}` (not an error).
   - `.json`: `readFile` as UTF-8, `JSON.parse`; a parse failure throws `ArgusConfigError('argus.config.json',
     undefined, 'not valid JSON', { cause })`.
   - `.js`: loaded with `createRequire(path.join(cwd, 'noop.js'))(absoluteFilePath)` from `node:module`. The
     same code path runs in the ESM and the CJS build. A CommonJS file yields `module.exports`. An ES module is
     loaded through Node's `require(esm)` and yields a module namespace; when
     `util.types.isModuleNamespaceObject(result)` is true, the config is `result.default`. Any load error is
     wrapped as `ArgusConfigError('argus.config.js', undefined, 'failed to load', { cause })`.
     **Why not `import()`:** `tsconfig.cjs.json` compiles with `module: CommonJS`, which rewrites `import()`
     into `require()`; a `file://` URL then breaks and the two builds would behave differently. `createRequire`
     is explicit and identical in both.
   - The parsed or loaded value must be a plain object (not `null`, not an array), else `ArgusConfigError`
     naming the file. Its own keys (`Object.keys`) must each be one of `intervalMs`, `output`, `queueBound`,
     `enabled`; an unknown key (including `__proto__` from JSON) throws naming the file and that key. Each
     known key's value goes through `validateConfigValue(fileName, key, value)` with no type coercion: a JSON
     `"100"` for `intervalMs` is invalid.
   - A relative `output` path from the file resolves against `cwd` with `path.resolve`; `'stdout'` and
     `'none'` stay as given.
3. **Environment source** (`src/agent/config-env.ts`): `readConfigEnv(env, cwd): Partial<…>`.
   - Considers only keys starting with `ARGUS_`; others are ignored. Known names map to keys:
     `ARGUS_INTERVAL_MS` → `intervalMs`, `ARGUS_OUTPUT` → `output`, `ARGUS_QUEUE_BOUND` → `queueBound`,
     `ARGUS_ENABLED` → `enabled`. Any other `ARGUS_` name throws `ArgusConfigError(<that name>, undefined,
     'unknown variable')`. A value of `undefined` is skipped (the variable is unset).
   - Integers: the string must match `/^[0-9]+$/` (so `""`, `"abc"`, `"1.5"`, `"-1"`, `" 5"` all fail),
     then `Number(...)` and `validateConfigValue`. Booleans: exactly `true`/`1` → `true`, `false`/`0` →
     `false`; anything else (including `"yes"` and `""`) fails. Output: `""` fails; otherwise as for the file.
   - The error's `source` is the variable name (e.g. `ARGUS_INTERVAL_MS`) and its `key` the config key, so the
     message carries both.
4. **Loader** (`src/agent/config.ts`): `loadAgentConfig(cwd: string, env: Readonly<Record<string, string |
   undefined>>): Promise<AgentConfig>`.
   - Reads the env layer first (synchronous, so an env error is raised even when the file is also bad; order of
     errors is not part of any criterion), then the file layer, then returns
     `Object.freeze({ ...defaultAgentConfig, ...fromFile, ...fromEnv })`. All four keys are always present.
   - The env object is passed in, never read from `process.env` inside the loader, so tests stay hermetic; the
     later entry slice passes `process.env` and `process.cwd()`.
   - No try/catch that falls back to defaults: every failure propagates as a rejected promise.
5. **Entrypoint** (`src/agent/index.ts`): keep every current export and `ArgusAgentPlaceholder`; add
   `loadAgentConfig`, `defaultAgentConfig`, `ArgusConfigError` and the type `AgentConfig`. `readConfigFile`,
   `readConfigEnv` and `validateConfigValue` stay internal.

Constraints held by construction:

- Imports are `node:fs/promises`, `node:path`, `node:module` and `node:util`, plus relative files. No
  third-party or workspace import, which the existing eslint agent rule enforces. No `async_hooks` import.
- Integer values are validated with `Number.isSafeInteger`, never coerced from floats.
- No config, script, runner or other test-infra file is touched, and no dependency is added.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`, and
  `memory-bank/lessons-learned.md` does not exist), so there are no lessons to apply.

## Steps

- Add `src/agent/config-schema.ts` with `AgentConfig`, the frozen `defaultAgentConfig`, the bounds,
  `ArgusConfigError` and `validateConfigValue`.
- Add `src/agent/config-file.ts` with `readConfigFile(cwd)`: the two-file existence check, the JSON parse,
  the `createRequire` load with namespace unwrapping, the plain-object and unknown-key checks, and per-key
  validation.
- Add `src/agent/config-env.ts` with `readConfigEnv(env, cwd)`: the `ARGUS_` filter, unknown-variable
  rejection, and strict integer, boolean and output parsing.
- Add `src/agent/config.ts` with `loadAgentConfig(cwd, env)`, merging defaults, file and env, and freezing.
- Update `src/agent/index.ts` to re-export the loader, the defaults, the error class and the type.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`. Both the
  ESM and CJS builds must keep compiling.

## Files

- `src/agent/config-schema.ts` — new. `AgentConfig` type, frozen `defaultAgentConfig`, integer bounds, `ArgusConfigError`, `validateConfigValue`.
- `src/agent/config-file.ts` — new. `readConfigFile(cwd)`: finds `argus.config.json` / `argus.config.js` in `cwd`, rejects both, parses JSON or loads the module via `createRequire`, rejects unknown keys, validates values.
- `src/agent/config-env.ts` — new. `readConfigEnv(env, cwd)`: maps `ARGUS_*` variables to keys, rejects unknown `ARGUS_` names, parses integers and booleans strictly.
- `src/agent/config.ts` — new. `loadAgentConfig(cwd, env)`: defaults, then file, then env; returns a frozen config.
- `src/agent/index.ts` — modified. Re-exports `loadAgentConfig`, `defaultAgentConfig`, `ArgusConfigError` and `AgentConfig`; keeps every existing export and `ArgusAgentPlaceholder`.

### Explicitly not touched

- `src/agent/ndjson-exporter.ts`, `src/agent/sampler-controller.ts`, `src/agent/bounded-queue.ts` — reused as is; wiring the config into them is out of scope.
- `src/agent/event-loop-sampler.ts`, `src/agent/memory-sampler.ts`, `src/agent/ndjson-encoder.ts` — reused as is.
- `src/agent/index.test.ts` and the `agent-samplers` / `agent-ndjson-export` AC tests — existing tests, left as is.
- `src/collector/index.ts` — still imports `ArgusAgentPlaceholder`, which stays exported.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`, `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (JSON file sets interval and an absolute output path; env sets `ARGUS_INTERVAL_MS` and
  `ARGUS_ENABLED="0"`; result has env interval, file output, `enabled: false`, default queue bound, frozen;
  integration): the merge order defaults → file → env gives the env interval over the file's, the file's
  output (absolute, so `path.resolve` leaves it unchanged), `"0"` parsed to `false`, and `queueBound` from
  `defaultAgentConfig` (exported, so the test can compare against it). `Object.freeze` on the merged object
  makes `Object.isFrozen` true.
- **AC-2** (a CommonJS `argus.config.js` via `module.exports` and an ESM one via `export default`, empty env;
  each result carries its file's interval, queue bound and output; integration): `createRequire` returns
  `module.exports` for the CommonJS file and a module namespace for the ES module, which the loader unwraps to
  `default`. Both pass the same key and value checks.
- **AC-3** (invalid JSON; unknown key `foo`; queue bound `0`; `ARGUS_INTERVAL_MS="abc"`;
  `ARGUS_ENABLED="yes"`; both files present; each fails with a message naming the source and key; integration):
  each case raises an `ArgusConfigError` whose message is built from `source` and `key`:
  `argus.config.json` (invalid JSON, no key), `argus.config.json` + `foo`, `argus.config.json` +
  `queueBound`, `ARGUS_INTERVAL_MS` + `intervalMs`, `ARGUS_ENABLED` + `enabled`, and the both-files message
  naming `argus.config.json` and `argus.config.js`. The loader returns a rejected promise in each case.

## Risks & open questions

- **ES module config files need `require(esm)`**, unflagged from Node 22.12. On Node 22.0 to 22.11 loading an
  ESM `argus.config.js` fails with Node's `ERR_REQUIRE_ESM`, which the loader surfaces wrapped as an
  `ArgusConfigError` naming the file (loud, not silent). The local runtime is Node 24, and `.nvmrc` `22`
  resolves to the latest 22.x. Flagged for `/pharn-grill`: whether to raise `engines` to `>=22.12` is a
  separate infra change, not in this plan's scope. Some 22.x releases also print an `ExperimentalWarning` on
  `require(esm)`.
- **The AC-2 tests must pin the module format** of each temporary directory explicitly: write a
  `package.json` with `"type": "commonjs"` next to the CommonJS file and `"type": "module"` next to the ESM
  file. Temporary directories under `os.tmpdir()` are outside the repo, so the root `"type": "module"` does
  not apply, and relying on Node's syntax detection would make the test depend on a Node default.
- **`require` caches modules.** A second `loadAgentConfig` on the same directory returns the cached module
  even if the file changed. Reloading is out of scope, and each test uses its own directory, so no cache
  busting is added (P7).
- **A `.js` config file executes code** with the process's privileges. That is the documented contract of a
  `.js` config (FEATURES.md lists it) and the file sits in the user's own project directory; noted for the
  later README.
- **Unknown `ARGUS_` variables are rejected** (SPEC assumption), so a stray `ARGUS_` variable in a user's
  shell makes the loader fail. That is the approved behavior; the error names the variable.
- **Default and bound values** (interval 1000 ms, max one hour; queue bound 1024, max 1_000_000) are PLAN
  choices the SPEC left open.
- **`CLAUDE.md` still describes a pnpm monorepo**; the live repo is a single npm package. Out of scope here,
  flagged for the human (as in the earlier agent slices).
