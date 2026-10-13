---
spec_id: phargus-serve-cli
spec_content_hash: 0c1f884c4ecd195fe4165072ffce115b9c3923058dc80ee2b497975f26519759
applied_lessons: none
---

> ADVISORY: this plan is model work derived from the Approved SPEC. Only the gates named in
> `/pharn-plan` (spec approval, lessons declaration, AC mapping) are floor-checked; the content
> below is not.

## Approach

Add a seventh source directory, `src/cli/`, holding a small ESM-only executable that wires the
existing public APIs together exactly as the README's hand-written collector does:

```
stdin | file  ->  createNdjsonDecoder({ maxLineBytes })  ->  collector.consume(records)
                                                              |
                                  createDashboardServer({ collector, host, port, token })
```

Key decisions (all advisory):

1. **ESM-only CLI.** The bin is executed, never `require()`d, and it is not an `exports` subpath.
   `src/cli/**` is excluded from `tsconfig.cjs.json`, so the CLI may use `import.meta.url` (to find
   its own `package.json`) and top-level `await` without the CommonJS emit errors those cause.
   Every existing `exports` subpath keeps its dual build untouched. `bin` maps
   `phargus` to `dist/esm/cli/bin.js` (the `dist/esm/package.json` the build writes pins it to ESM).
2. **Imports.** The CLI imports only `node:` builtins, `../collector/index.js` and
   `../dashboard/index.js` (the public entrypoints). An ESLint block on `src/cli/**/*.ts` enforces
   that, and the agent's existing block gains `cli` in its forbidden-module regex (AC-10).
3. **One loopback rule.** The CLI must refuse a non-loopback host without a token *before anything
   binds* and with exit 2. Rather than duplicate the dashboard's rule, `src/dashboard/index.ts`
   re-exports the existing `isLoopbackHost` from `./auth.js` (additive public API; nothing removed
   or changed). `createDashboardServer`'s own check stays as the backstop.
4. **Exit codes.** `main(argv)` returns a number: 0 help/version/graceful shutdown, 2 usage error
   (`UsageError` thrown by the argument layer, including the refused host/token combination),
   1 runtime error. `bin.ts` sets `process.exitCode` and lets the loop drain, so stderr written on a
   pipe (asynchronous on macOS) is not truncated by `process.exit()`.
5. **Errors print without stacks** (`phargus: <message>`) unless `PHARGUS_DEBUG` is set to a
   non-empty value, in which case `error.stack` is printed.
6. **Order of startup** (so failures surface before side effects): parse and validate args (2) →
   resolve token (`--token` over `PHARGUS_TOKEN`; an empty `PHARGUS_TOKEN` counts as unset) → refuse
   non-loopback without token (2) → open the input file if one was named (1 on failure, naming the
   path) → create the collector → create the dashboard server (1 on failure, e.g. `EADDRINUSE`,
   naming host and port; the opened file handle and the collector are closed first) → print the URL
   line → start the input pipeline. `process.stdin` is touched only when it is the input, and only
   after the server is listening.
7. **Input pipeline.** `pipeline(input, decoder, (records) => collector.consume(records), { signal })`
   from `node:stream/promises` (never `.pipe()`). When it resolves: print the input-ended line and
   the counts line, keep serving (the listening server keeps the process alive). When it rejects
   while no shutdown is in progress: print the error and the counts, shut down, exit 1. When it
   rejects after shutdown began (abort, premature close): expected, not reported as a failure.
8. **Shutdown.** First SIGINT/SIGTERM: print `phargus: received <SIGNAL>, shutting down`, abort the
   input, `await dashboard.close()` (it ends every SSE response through `closeAllConnections`),
   `await collector.close()`, print the counts line, remove the signal listeners, return 0. A
   `SHUTDOWN_TIMEOUT_MS = 5000` timer (`unref()`ed, so it only fires when something keeps the loop
   alive) prints a timeout line plus the counts and calls `process.exit(1)`. A second signal during
   shutdown exits 1 at once. Every `close()` failure is printed, never swallowed, and turns the exit
   code to 1.
9. **Diagnostics go to stderr only**, through one formatter, so tests can parse them:
   - `phargus: dashboard at http://<host>:<port>` (the dashboard's own `url`, never the token); when a
     token is in force a second line reads
     `phargus: a token is required: open http://<host>:<port>/?token=<token> once, or send Authorization: Bearer <token>`
     with the literal text `<token>`, never the value.
   - `phargus: input ended; still serving the collected data (Ctrl-C to stop)`
   - `phargus: counts: decoder.invalid=<n> decoder.oversized=<n> collector.ignored=<n> dashboard.droppedEvents=<n>`
     printed when the input ends and again at exit (graceful, failed or timed out).
   - dashboard `onError` reports as `phargus: dashboard error: <message>`.
   No periodic count report (the SPEC makes it optional; left out to keep stderr quiet).
10. **Fixed defaults:** port 7070, host `127.0.0.1`, window 1000 ms, ring capacity 300 windows (five
    minutes, as the README example), span capacity `DEFAULT_SPAN_CAPACITY`, max line bytes
    `DEFAULT_MAX_LINE_BYTES`. No capacity flag (no criterion needs one).

## Applied lessons

- none — `check-lessons-index.mjs --verdict` returned `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md` yet, so there are no promoted lessons to apply.

## Steps

1. `src/cli/args.ts`: `parseServeArgs(argv: readonly string[], env: NodeJS.ProcessEnv)` built on
   `node:util` `parseArgs({ strict: true, allowPositionals: true })` with options `help` (`-h`),
   `version` (`-v`), `port`, `host`, `token`, `window-ms`, `max-line-bytes`. Returns a discriminated
   union `{ kind: 'help' } | { kind: 'version' } | { kind: 'serve', options: ServeOptions }`.
   Throws `UsageError` (exported class, `exitCode = 2`) for: `parseArgs` errors (its
   `ERR_PARSE_ARGS_*` message already names the flag, e.g. `--bogus`), no command, an unknown
   command, more than one input positional, `--port` not matching `^[0-9]{1,5}$` or above 65535,
   `--window-ms` / `--max-line-bytes` not matching `^[0-9]+$` or not a positive safe integer, an
   empty `--host` or `--token`, and a non-loopback host (`isLoopbackHost` from the dashboard
   entrypoint) with no token. Every message names the flag and the offending value (never the token
   value); the host/token message says a token is required for a non-loopback host and names
   `--token` and `PHARGUS_TOKEN`. `--help` / `--version` win over everything else, with or without
   `serve`. Input: no positional or `-` → stdin, anything else → that file path.
2. `src/cli/usage.ts`: `USAGE` text naming `phargus serve [options] [file|-]`, every flag with its
   default, `PHARGUS_TOKEN` and `PHARGUS_DEBUG`, and the two-command quick start.
3. `src/cli/version.ts`: `readPackageVersion()` walks up from `dirname(fileURLToPath(import.meta.url))`
   (bounded, a handful of levels) to the first `package.json` whose `name` is `@pharn-dev/phargus`
   and returns its `version`; skips the name-less `dist/esm/package.json`. Throws a plain `Error`
   (exit 1) if none is found.
4. `src/cli/report.ts`: the stderr side: `writeLine(text)`, `formatCounts(...)` producing the
   `counts:` line above, `describeError(error, debug)` (message only, or `stack` when debug), and
   `isDebug(env)`.
5. `src/cli/input.ts`: `openInput(spec)` returns `{ stream: Readable, close(): Promise<void>, label }`:
   for a file, `await open(path, 'r')` from `node:fs/promises` then `handle.createReadStream()`
   (fails early with a message naming the path); for stdin, a lazy accessor so `process.stdin` is
   not touched until the pipeline starts.
6. `src/cli/serve.ts`: `runServe(options, io)` implementing Approach points 6 to 10, with `io`
   carrying `stderr`, `env`, `stdin` accessor and a signal source (defaulting to `process`) so the
   lifecycle stays readable. Returns the exit code.
7. `src/cli/main.ts`: `main(argv, io)`: parse → help (`USAGE` to stdout, 0) / version (stdout, 0) /
   serve (`runServe`). Catches `UsageError` → `phargus: <message>` plus
   `Run 'phargus --help' for usage.` on stderr, 2. Any other error → `describeError`, 1.
8. `src/cli/bin.ts`: first line `#!/usr/bin/env node`; calls `main(process.argv.slice(2))` and sets
   `process.exitCode`; a rejection prints through `describeError` and sets 1.
9. `src/dashboard/index.ts`: add `export { isLoopbackHost } from './auth.js';` with a doc comment.
10. `tsconfig.cjs.json`: add `"src/cli/**"` to `exclude`.
11. `package.json`: add `"bin": { "phargus": "dist/esm/cli/bin.js" }`. No dependency, no version bump,
    no script change.
12. `scripts/build.mjs`: after the ESM build, assert `dist/esm/cli/bin.js` starts with
    `#!/usr/bin/env node\n` (fail the build otherwise) and `chmodSync(..., 0o755)` it. Read the bin
    path from `package.json` `bin` rather than hard-coding it.
13. `scripts/check-exports.mjs`: additionally, for each `bin` entry: the file exists, starts with the
    shebang, has an executable mode bit (POSIX only), and `node <file> --help` exits 0 with `serve`
    in stdout. Report `ok   bin     phargus` / `FAIL bin ...` lines in the existing style.
14. `scripts/check-package.mts`: `bin` must be a non-empty object; every target must be in the
    `npm pack --dry-run --json` file list and its listed `mode` must have an executable bit.
15. `scripts/check-install.mjs`: after the install step, run `npm exec --no -- phargus --help` in the
    consumer through the existing `npm()` helper (non-zero exit fails the check), and print
    `ok   installed bin (npx phargus --help)`.
16. `eslint.config.mjs`: add `cli` to the agent block's module regex; add a `src/cli/**/*.ts` block
    (ignoring `src/cli/**/*.test.ts`) with `no-restricted-imports` patterns: `^(?!node:|\.)` (no
    third-party) and `^\.\./(?!(collector|dashboard)/index\.js$)` (other modules only through their
    entrypoints).
17. `examples/express-app/app.mjs`: when there is no IPC channel, log the listening URL to stderr and
    keep serving instead of exiting 1, so `node examples/express-app/app.mjs | phargus serve` works;
    behaviour under `index.mjs` (IPC present) is unchanged.
18. Docs: README quick start becomes the two commands
    (`node --import @pharn-dev/phargus/agent app.mjs | npx phargus serve`), a `phargus serve` section
    (flags, defaults, file replay, token via `PHARGUS_TOKEN` set on the `phargus serve` side only, exit
    codes, stderr-only diagnostics); the hand-written collector stays as "Using the library APIs";
    `examples/express-app/README.md` gets a "With the CLI" section; `FEATURES.md` §1 (the 🟡 line and a
    CLI bullet) and §5; `ARCHITECTURE.md` module boundaries (`src/cli`: Node core plus the collector
    and dashboard entrypoints, nothing imports it, the agent may not) and build section (CLI is
    ESM-only, not an `exports` subpath, `bin` checked by the check scripts);
    `docs/THREAT-MODEL.md` new row (next free id in the dashboard/collector-input area, e.g. `B5`)
    for the CLI listener and its untrusted stdin/file parsing; `CHANGELOG.md` `### Added` as the
    first subsection of `## [Unreleased]` (the only `### Added` there).
19. Run `npx prettier --write` on every touched file, one by one, then `npm run build`,
    `npm run check:exports`, `npm run check:package`, `npm run typecheck`, `npm run lint`,
    `npm test`.

## Files

- `src/cli/bin.ts` — executable entry with the `#!/usr/bin/env node` first line; calls `main` and sets the exit code
- `src/cli/main.ts` — command dispatch (help, version, serve) and error-to-exit-code mapping
- `src/cli/args.ts` — `parseArgs`-based parsing and validation, `UsageError`, token resolution and the non-loopback refusal
- `src/cli/usage.ts` — the `--help` text
- `src/cli/version.ts` — reads the package version from the package's own `package.json`
- `src/cli/report.ts` — stderr formatting: counts line, error description, debug switch
- `src/cli/input.ts` — opens the stdin or file input
- `src/cli/serve.ts` — the serve lifecycle: decoder, collector, dashboard, pipeline, signals, bounded shutdown
- `src/dashboard/index.ts` — re-export `isLoopbackHost` from `./auth.js` (additive)
- `tsconfig.cjs.json` — exclude `src/cli/**` from the CommonJS build
- `package.json` — add `bin` (`phargus` → `dist/esm/cli/bin.js`); nothing else changes
- `scripts/build.mjs` — assert the bin's shebang and make it executable after the build
- `scripts/check-exports.mjs` — verify each built bin exists, has the shebang, is executable and answers `--help`
- `scripts/check-package.mts` — verify `bin` is declared and each target ships with an executable mode
- `scripts/check-install.mjs` — run `npx phargus --help` from the installed tarball
- `eslint.config.mjs` — forbid agent imports of `cli`; restrict `src/cli` imports to `node:` and the collector and dashboard entrypoints
- `examples/express-app/app.mjs` — keep serving when started without an IPC channel (piped into the CLI)
- `examples/express-app/README.md` — show the CLI path
- `README.md` — two-command quick start and a `phargus serve` section
- `FEATURES.md` — record the CLI
- `ARCHITECTURE.md` — module boundaries and build notes for `src/cli`
- `docs/THREAT-MODEL.md` — a row for the CLI's network listener and the untrusted input it parses
- `CHANGELOG.md` — `### Added` entry under `## [Unreleased]`

### Explicitly not touched

- `src/agent/` — out of scope (no behaviour, import or dependency change)
- `src/collector/` — reused through its public entrypoint only
- `src/dashboard/server.ts` — reused; its own non-loopback check stays as the backstop
- `src/dashboard/auth.ts` — reused; only re-exported
- `vitest.config.mts` — test infrastructure, pinned by `/pharn-test`
- `tsconfig.json` — unchanged; `src/cli` is already covered by its include
- `tsconfig.esm.json` — unchanged; `src/cli` is already covered by its include
- `examples/express-app/index.mjs` — the hand-wired example stays as is
- `CLAUDE.md` — no new standing convention; the CLI's import boundary is enforced by ESLint

## Acceptance mapping

- AC-1 (`--help`, `--version`) → `args.ts` recognises both; `main.ts` writes `USAGE` (names `serve`,
  `--port`, `--host`, `--token`, `--window-ms`, `--max-line-bytes`) or `readPackageVersion()` to
  stdout and returns 0.
- AC-2 (unknown flag, bad values) → `parseArgs` strict mode names `--bogus`; the numeric validators
  name `--port`, `--window-ms`, `--max-line-bytes`; `UsageError` → message without stack, exit 2.
- AC-3 (token) → `args.ts` refuses a non-loopback host with no token before binding (exit 2, message
  says a token is required for a non-loopback host); `PHARGUS_TOKEN` resolves the token, which is
  passed to `createDashboardServer`, whose existing auth yields 401 without and 200 with
  `Authorization: Bearer`.
- AC-4 (stdin, mixed lines, input end) → decoder counts plain-text lines as `decoder.invalid`,
  collector counts pino-style objects as `collector.ignored`; the URL line names the bound port;
  windows reach SSE clients live and through the dashboard's replay after input end; the
  input-ended and counts lines are printed and the server keeps the process alive.
- AC-5 (real agent piped in) → same pipeline over the agent's real NDJSON on stdin.
- AC-6 (file and `-`) → `input.ts` reads a file path or stdin for `-`; a missing path fails in
  `open()` before binding: exit 1, message naming the path, no stack.
- AC-7 (SIGTERM / SIGINT) → shutdown aborts the input, closes the server (ending SSE responses) and
  the collector, prints the counts, exits 0 well inside 10 s; bounded by the 5 s force timer.
- AC-8 (port in use, `PHARGUS_DEBUG`) → `createDashboardServer` rejects with `EADDRINUSE`;
  `serve.ts` reports it naming host and port, exit 1; `describeError` adds the stack when
  `PHARGUS_DEBUG` is set.
- AC-9 (packed tarball) → `bin` in `package.json`; the shebang survives `tsc` (it preserves a leading
  `#!` line) and `build.mjs` asserts it; npm marks bin targets executable in the tarball and
  `build.mjs` also sets `0o755` on disk.
- AC-10 (ESLint boundary) → `cli` added to the agent block's forbidden-module regex, so an agent
  file importing `../cli/...` gets a `no-restricted-imports` error.

## Risks & open questions

- **`PHARGUS_TOKEN` and the agent.** The agent warns about any unknown `PHARGUS_*` variable in its
  own environment (`src/agent/config-env.ts`). A user who `export`s `PHARGUS_TOKEN` (or
  `PHARGUS_DEBUG`) gets a harmless warning from the app's agent. The SPEC forbids agent changes, so
  the docs tell users to set these on the `phargus serve` side only
  (`... | PHARGUS_TOKEN=... npx phargus serve`). AC tests must not pass them to the app process.
- **New public export.** `isLoopbackHost` becomes part of `@pharn-dev/phargus/dashboard`. It is
  additive and keeps one copy of the rule; the alternative (a private copy in the CLI) was rejected
  as duplicated security logic. The grill may prefer otherwise.
- **CLI not in `dist/cjs`.** Deliberate (Approach 1). `check:exports` still covers every `exports`
  subpath in both formats; the bin is checked separately.
- **`npm pack` in tests.** `prepack` runs `npm run build`, which deletes `dist/`; a test that packs
  must use `--ignore-scripts` after the shared, locked build (the
  `phargus-dist-build-<hash>.lock` pattern of `src/dashboard/example-express-app.ac1.integration.test.ts`),
  or it can break concurrently running tests.
- **AC-10 test mechanics.** Linting a virtual `src/agent/*.ts` with `ESLint#lintText` goes through
  the typed `projectService`; if typescript-eslint refuses a file that is not on disk, the test
  should either lint a temporary file it creates and removes, or override the config with
  `disableTypeChecked` for that call. A test-stage decision.
- **Spawning the CLI.** Tests spawn the built `dist/esm/cli/bin.js` after the shared locked build
  (source spawning through type stripping cannot resolve the `.js` relative imports), with
  `dist/esm/cli/bin.js` in the freshness list, `--port 0`, event-driven waits and a child env with
  `PHARGUS_*` stripped except where a test sets one.
- **Shutdown exit path.** Graceful shutdown relies on the loop draining (no `process.exit`), so a
  leaked handle would show up as the 5 s timeout (exit 1) rather than a hang; that is the intended
  failure mode.
- **`--token` on the command line** is visible in the process list; the help text, README and the
  threat-model row recommend `PHARGUS_TOKEN`.
