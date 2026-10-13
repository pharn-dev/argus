---
spec_id: phargus-serve-cli
state: Approved
spec_content_hash: 0c1f884c4ecd195fe4165072ffce115b9c3923058dc80ee2b497975f26519759
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
---

## Intent

Review finding F4 (High). Phargus promises "one line, runs in-process" diagnostics, but the one line
only makes the agent write NDJSON to the app's stdout. To see a dashboard today a user must write
their own collector program (README "Add the live dashboard", roughly lines 99 to 116): wire
`createNdjsonDecoder`, `createCollector` and `createDashboardServer` together by hand. The package
has no `bin` and no CLI. At 2am nobody wants to write glue code. Users want two commands: run the
app with the agent, and pipe its output into `phargus serve`, which prints the dashboard URL. The
CLI must keep every guarantee the hand-written version has (token-gated off loopback, foreign lines
skipped and counted, no silent failures) and must ship inside the existing package without adding a
runtime dependency.

## Scope

**In scope:**

- A `phargus` executable declared in the package's `bin`, with a `serve` command:
  `phargus serve [--port <n>] [--host <h>] [--token <t>] [--window-ms <n>] [--max-line-bytes <n>] [file|-]`.
  Defaults: port 7070, host 127.0.0.1. Input is stdin by default; a file path reads that file; `-`
  means stdin.
- The input runs through the collector entrypoint's existing `createNdjsonDecoder` into
  `createCollector`, served by the dashboard entrypoint's existing `createDashboardServer`, reusing
  those public APIs and exposing only the options that are useful from a command line.
- `phargus --help` and `phargus --version` (the version read from the package manifest).
- Argument parsing with `node:util` `parseArgs`; no new dependency.
- Exit codes: 0 for help, version and a graceful shutdown; 2 for an unknown flag, a bad flag value or
  a refused flag combination, with a clear message; 1 for a runtime error, with a clear message and no
  stack trace unless the `PHARGUS_DEBUG` environment variable is set.
- Security: a non-loopback `--host` without a token is refused before anything binds, matching the
  dashboard's token-gated-by-default rule; the token is also accepted from the `PHARGUS_TOKEN`
  environment variable.
- Lifecycle: SIGINT and SIGTERM close the dashboard server and the collector gracefully within a
  bounded time. When the input ends, the CLI logs that the input ended and keeps serving the
  collected data until interrupted.
- Diagnostics: the dashboard URL, the input-ended notice, errors, and the decoder skip counts and the
  collector `ignored` count go to stderr only. The counts are reported when the input ends and at
  exit (and may also be reported periodically), so no skipped line is silent.
- Packaging: the executable keeps its `#!/usr/bin/env node` first line through the dual build; the
  build, `check:exports`, `check:package` and `check:install` scripts are extended so the bin is
  verified (declared, present in the tarball, executable, and `npx phargus --help` works from an
  installed tarball).
- CLI source in its own module directory under `src/`, with ESLint boundary rules so the agent cannot
  import it, and `ARCHITECTURE.md`'s who-may-import-what updated.
- Docs: the README quick start becomes two commands (the app with the agent, piped into
  `phargus serve`); `examples/express-app` shows the CLI path; `FEATURES.md`, `docs/THREAT-MODEL.md`
  (a row for the new network listener and its untrusted input parsing) and other `docs/` pages updated
  where relevant; a `### Added` entry under `## [Unreleased]` in `CHANGELOG.md`, with a single
  `### Added` heading in that section.
- Vitest tests that spawn the CLI as a child process, for the criteria below.

**Out of scope (non-goals):**

- Bumping the package version or cutting a release.
- Any change to `src/agent` behaviour, imports or dependencies, or to what the agent writes.
- Subcommands other than `serve`, and a configuration file for the CLI.
- Exposing alert rules, alert sinks, disk persistence or OTLP export as CLI flags.
- Spawning or supervising the monitored app from the CLI (the app is piped in, not launched).
- Showing the skip counts in the dashboard UI.
- Removing or changing the library APIs that the hand-written collector program uses.

## Scenarios

- A developer debugging a slow service at 2am runs
  `node --import @pharn-dev/phargus/agent app.mjs | npx phargus serve`, reads
  `http://127.0.0.1:7070` on stderr, opens it, and watches windows arrive. The app's own log lines on
  the same stdout do not break anything; they are counted and reported on stderr. When the app exits
  the dashboard stays up with the collected data until the developer presses Ctrl-C.
- An operator on a server runs `phargus serve --host 0.0.0.0` and is told a token is required; they set
  `PHARGUS_TOKEN` and run it again, and the dashboard now asks for the token.
- A developer replays a captured NDJSON file with `phargus serve capture.ndjson` to look at it after
  the fact.

## Acceptance Criteria

- **AC-1** Given the `phargus` CLI When it is run with `--help`, and separately with `--version`
  Then the `--help` run exits 0 and prints to stdout a usage text that names the `serve` command and
  each of `--port`, `--host`, `--token`, `--window-ms` and `--max-line-bytes`; and the `--version` run
  exits 0 and prints to stdout the `version` value of the package's `package.json`
  - verify: integration
- **AC-2** Given the `phargus` CLI When `serve` is run with an unknown flag `--bogus`, and separately
  with each of the bad values `--port abc`, `--port 70000`, `--window-ms 0` and `--max-line-bytes 0`
  Then every run exits 2, its stderr names the offending flag, and its stderr contains no stack-trace
  line (no line starting with whitespace followed by `at `)
  - verify: integration
- **AC-3** Given no `PHARGUS_TOKEN` in the environment When `phargus serve --host 0.0.0.0 --port 0` is
  run with no `--token` Then it exits 2 with a stderr message saying a token is required for a
  non-loopback host; and given `PHARGUS_TOKEN` set to a value When `phargus serve --port 0` runs on the
  loopback host Then a `GET /events` without credentials gets HTTP 401 and a `GET /events` with
  `Authorization: Bearer <that value>` gets HTTP 200
  - verify: integration
- **AC-4** Given `phargus serve --port 0 --window-ms 1000` reading stdin When stdin receives agent
  sample lines encoded the way the agent writes them, with timestamps spanning at least two windows,
  interleaved with N plain-text log lines and M pino-style JSON log lines, and then stdin ends Then
  stderr prints a dashboard URL of the form `http://127.0.0.1:<port>` naming the bound port; an SSE
  client on that URL's `/events` receives at least one `window` event; stderr reports that the input
  ended, with a decoder skip count equal to N and a collector ignored count equal to M; and after the
  input ended the process is still running and a new SSE client on `/events` still receives a `window`
  event
  - verify: integration
- **AC-5** Given an app process started with `node --import` of the built agent entrypoint, its stdout
  connected to the stdin of `phargus serve --port 0` When the app runs and also writes plain-text log
  lines to stdout Then an SSE client on the printed URL's `/events` receives at least one `window`
  event produced from the real agent's samples
  - verify: integration
- **AC-6** Given an NDJSON file holding agent sample lines spanning at least two windows When
  `phargus serve --port 0 <that file>` is run, and separately the same content is fed through
  `phargus serve --port 0 -` on stdin Then in both runs an SSE client on `/events` receives at least
  one `window` event; and given a path that does not exist When `phargus serve --port 0 <that path>` is
  run Then it exits 1 with a stderr message naming the path and no stack-trace line
  - verify: integration
- **AC-7** Given a running `phargus serve --port 0` whose input has not ended and an SSE client
  connected to `/events` When the process receives SIGTERM, and in a separate run SIGINT Then the
  process exits with code 0 within 10 seconds of the signal, the SSE client's response ends, and stderr
  reports the decoder skip counts and the collector ignored count
  - verify: integration
- **AC-8** Given a port already bound by another listener on 127.0.0.1 When `phargus serve` is run with
  `--port` set to that port Then it exits 1 with a stderr message that names the port and contains no stack-trace
  line; and When the same run has `PHARGUS_DEBUG=1` in its environment Then it still exits 1 and its
  stderr contains a stack-trace line
  - verify: integration
- **AC-9** Given the package packed with `npm pack` When the tarball's manifest and file entries are
  read Then the manifest's `bin` maps `phargus` to a file that is present in the tarball, whose first
  line is `#!/usr/bin/env node`, and whose file mode is executable
  - verify: integration
- **AC-10** Given the repository's ESLint configuration When it lints a TypeScript file under
  `src/agent/` that imports from the CLI's source directory Then ESLint reports a
  `no-restricted-imports` error for that import
  - verify: integration

## Constraints

- Zero runtime `dependencies` in the root `package.json`; the CLI uses Node core and the package's own
  collector and dashboard entrypoints only. `src/agent` gains no import and no dependency.
- Node 22.18.0 floor; npm only; TypeScript strict mode; prettier on every touched file; the package
  version is not bumped.
- Dual ESM and CJS build stays correct: every existing `exports` subpath still loads through `import`
  and `require` (`npm run check:exports`), and the bin works from the built output.
- Stream wiring uses `stream/promises` `pipeline()`, never `.pipe()`.
- No silent failure: every stream, server and signal path has explicit error handling; skip counts
  are reported, never dropped.
- Diagnostics go to stderr only; nothing but `--help` and `--version` output goes to stdout.
- The token, from a flag or from `PHARGUS_TOKEN`, is never printed (not in the URL line, not in an
  error message).
- Shutdown on SIGINT or SIGTERM is bounded in time even when an SSE client stays connected.
- Tests do not depend on timing on a heavily loaded machine: generous timeouts, event-driven waits
  (on output lines, SSE events and process exit), no fixed sleeps, and ephemeral ports (`--port 0`).
- A threat-model row covers the new network listener and the untrusted input it parses
  (`CONTRIBUTING.md` rule).

## Assumptions

- A refused flag combination (a non-loopback host with no token) is a usage error and exits 2, like a
  bad flag value, because it is detected from the arguments before anything binds.
- A graceful shutdown on SIGINT or SIGTERM exits 0.
- `--token` takes precedence over `PHARGUS_TOKEN` when both are set.
- The dashboard URL line is printed to stderr (the README's hand-written collector already does
  this), and it never includes the token; a token-gated user is told to open `/?token=<token>`
  without the value being echoed.
- `--port 0` is accepted and binds an ephemeral port, and the printed URL names the real bound port;
  the tests rely on this to avoid port clashes.
- The collector's ring-buffer capacity and span capacity use fixed defaults chosen by the plan, not
  flags; the plan may add a flag only if it is needed for a criterion.
- Whether the tests spawn the built `dist` output (building first) or the TypeScript source through
  Node's type stripping is a plan decision; the criteria only require spawning the CLI as a child
  process.
- AC-5 relies on the agent's default sample interval (about one per second); its wait is event-driven
  with a generous timeout rather than a fixed delay.
- The `check:install` extension (running `npx phargus --help` from an installed tarball) and the
  README, example, `FEATURES.md`, `ARCHITECTURE.md`, threat-model and CHANGELOG edits have no
  acceptance criterion of their own; they are checked by review and by the existing format, lint,
  typecheck, build and package gates.
- The project has a findable test runner (`npm test` runs `vitest run`); the test stage's preflight
  confirms it.
