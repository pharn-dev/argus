---
spec_id: agent-permission-model
spec_content_hash: 529e2e6294f821961c22f5ebaafac10898d1070e5b84133b1425849df25a47b5
applied_lessons: none
---

## Approach

ADVISORY — model work, derived from the Approved SPEC (`pharn/ARCHITECTURE.md §6` plan stage).

Add one Node-core-only permission helper module and one typed error class to `src/agent`, then call the
helper's assert form at exactly two write sites, before any filesystem operation on the target path:

1. `openAgentOutput` (`src/agent/agent-output.ts`) — for a file destination (anything other than
   `'stdout'`), assert `fs.write` on `path.resolve(output)` before `createWriteStream`. The throw happens
   inside the async `start()` of `src/agent/auto-start.ts`, so it rejects `start()` and lands in the
   existing `reportOnce` — the single `[argus] agent disabled: ...` stderr line. The sampler controller is
   never started and no stream is opened, so nothing keeps the process alive and the host exits normally.
   `auto-start.ts` itself needs no change.
2. `takeHeapSnapshot` (`src/agent/heap-snapshot.ts`) — compute the absolute snapshot file path first, then
   assert `fs.write` on it **before** the existing `stat`/`access` directory checks. Ordering matters: under
   `--permission` without an fs-read grant for the directory, `stat` itself would throw `ERR_ACCESS_DENIED`
   and surface as the generic "directory does not exist" error instead of the typed one. The assert throws
   inside the `async` function, so it is a rejection (never a synchronous throw), and the existing
   `inProgress` `finally` resets the guard. No file is opened, so no `.heapsnapshot` is left behind.

The helper reads `process.permission` **at call time** (never cached at module load), so a unit test can stub
it. When the permission model is inactive (`process.permission` is `undefined`), the check returns allowed
and both features behave exactly as today. Both write sites keep their current behaviour otherwise.

Proposed public surface (names are the PLAN's choice, per the SPEC's Assumptions), exported from
`src/agent/index.ts` and therefore from `argus/agent`:

- `isPermissionModelEnabled(): boolean` — `true` iff `process.permission` is a non-null object.
- `checkPermission(scope: 'fs.read' | 'fs.write', reference: string): PermissionCheck` where
  `PermissionCheck = { allowed: boolean; scope: string; resource: string }`; `resource` is
  `path.resolve(reference)`; when the model is inactive returns `allowed: true` without calling anything;
  when active returns `allowed: process.permission.has(scope, resource)`.
- `assertPermission(scope, reference): void` — throws `ArgusPermissionError(scope, resource)` when
  `checkPermission` says denied.
- `class ArgusPermissionError extends Error` with `readonly scope: string`, `readonly resource: string`,
  `readonly code = 'ARGUS_ERR_PERMISSION_DENIED'`, `name = 'ArgusPermissionError'`, and a one-line message
  naming the scope, the resource and the missing flag (`--allow-fs-write=<resource or its directory>`).

TypeScript: `@types/node` declares `process.permission` as always present; the helper reads it through a
narrow local type (`{ permission?: { has(scope: string, reference?: string): boolean } }`) so the
`undefined` case is type-checked without `any`.

Docs: a new `docs/PERMISSIONS.md` with the minimal flag set and the statement that the agent spawns no
worker threads or child processes, linked from one line in the README's "Safety and honesty" section.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: the project has no
  `memory-bank/lessons-learned.md` yet, so there are no lessons to apply.

## Steps

- Create `src/agent/permission-error.ts` with `ArgusPermissionError` (scope, resource, code, message,
  optional `cause` via `ErrorOptions`).
- Create `src/agent/permission.ts` (imports `node:path`, `node:process`, and `./permission-error.js` only)
  with `isPermissionModelEnabled`, `checkPermission`, `assertPermission` and the `PermissionCheck` /
  `PermissionScope` types. No regex, no file system access, no caching.
- Edit `src/agent/agent-output.ts`: for a non-`'stdout'` output, `assertPermission('fs.write', output)`
  before `createWriteStream`.
- Edit `src/agent/heap-snapshot.ts`: after argument validation and setting `inProgress`, inside the `try`,
  resolve `dir`, build `filePath` (counter + stamp, as today), `assertPermission('fs.write', filePath)`, then
  the existing stat/access/write sequence unchanged.
- Edit `src/agent/index.ts`: export `isPermissionModelEnabled`, `checkPermission`, `assertPermission`,
  `ArgusPermissionError` and the types.
- Write `docs/PERMISSIONS.md`: `node --permission --allow-fs-read=<app dir> --allow-fs-read=<path to
node_modules/argus> [--allow-fs-write=<NDJSON output file or its directory>]
[--allow-fs-write=<heap snapshot dir>] --require argus/agent app.js`; that the config file
  (`argus.config.json` / `argus.config.js` in the cwd) is read under the app-dir grant; that `output:
'stdout'` needs no write grant; that a denied write disables only that feature with a typed error /
  one stderr line; that no `--allow-worker`, `--allow-child-process`, `--allow-addons` or `--allow-wasi`
  is needed; and that `--permission` is the flag on Node 22.13+ and 24 (`--experimental-permission` is
  not supported).
- Edit `README.md`: one bullet under "Safety and honesty" linking `docs/PERMISSIONS.md`.
- Run `node node_modules/prettier/bin/prettier.cjs --write` on each written file by name, then `npm run
typecheck`, `npm run lint`, `npm run build`, `npm run check:exports`, `npm test`.

## Files

- `src/agent/permission-error.ts` — new: the typed `ArgusPermissionError` (scope, resource, code).
- `src/agent/permission.ts` — new: `isPermissionModelEnabled`, `checkPermission`, `assertPermission`; reads `process.permission` at call time and resolves the path to absolute.
- `src/agent/agent-output.ts` — assert `fs.write` on the absolute output path before opening a file destination.
- `src/agent/heap-snapshot.ts` — assert `fs.write` on the absolute snapshot file path before the directory checks and the write.
- `src/agent/index.ts` — export the helper functions, their types and `ArgusPermissionError` from the agent entrypoint.
- `docs/PERMISSIONS.md` — new: the minimal `--permission` flag set for the agent and what each grant enables.
- `README.md` — one line in "Safety and honesty" linking `docs/PERMISSIONS.md`.

### Explicitly not touched

- `src/agent/auto-start.ts` — reused as is: a throw from `openAgentOutput` inside `start()` already reaches `reportOnce`.
- `src/agent/context.ts` — the only `async_hooks` importer; unrelated.
- `src/collector/`, `src/analyzer/`, `src/dashboard/`, `src/plugin-runner/` — out of scope per the SPEC.
- `package.json`, `vitest.config.ts`, `tsconfig*.json`, `scripts/` — no dependency, runner or build change.
- `docs/LIMITS.md`, `docs/THREAT-MODEL.md` — unchanged.

## Acceptance mapping

- AC-1 (unit) → `checkPermission` / `isPermissionModelEnabled` read `process.permission` at call time and
  pass `path.resolve(reference)` to `has`; `ArgusPermissionError` extends `Error` and exposes `scope` and
  `resource` as given. All reachable from `src/agent/index.ts`.
- AC-2 (integration) → `openAgentOutput` asserts `fs.write` first; with the grant the stream opens and
  samples are written as today; without it `start()` rejects into the single `reportOnce` line, no file is
  created, the controller never starts and the host exits 0.
- AC-3 (integration) → `takeHeapSnapshot` asserts `fs.write` on the absolute file path before any fs call;
  with the grant the existing write path runs (the test also grants fs-read on the directory so `stat`
  succeeds); without it the call rejects with `ArgusPermissionError { scope: 'fs.write', resource:
<dir>/argus-....heapsnapshot }` and nothing is written.

## Risks & open questions

- Integration tests must load the agent under `--permission`: the plan expects them to reuse the
  `agent-entry` pattern (compile `src/agent` with tsc into a temp package named `argus`, app script inside it,
  resolved through the package self-reference) and grant `--allow-fs-read` on that temp root, with the output
  or snapshot directory placed under it and `--allow-fs-write` on that subdirectory.
- macOS temp paths are symlinks (`/var/folders` → `/private/var/folders`). Grants and expected paths in tests
  should use `realpathSync` of the temp dir; the helper itself uses `path.resolve` (not `realpath`), per the
  SPEC's experiment facts that `has('fs.write', <absolute path>)` matches granted paths.
- The AC-3 child loads `argus/agent`, which auto-starts the agent; the test should set `ARGUS_OUTPUT=none`
  (or `ARGUS_ENABLED=0`) so the NDJSON export does not need a write grant there.
- `v8.writeHeapSnapshot` may itself be gated by the permission model; the pre-check makes that moot for the
  denied case, and the granted case relies on the fs-write grant covering the directory.
- Advisory: the helper checks only the target path; `createWriteStream`'s later open could still fail for a
  non-permission reason (ENOENT, EACCES) — that keeps today's `destination 'error'` → `reportOnce` path.
