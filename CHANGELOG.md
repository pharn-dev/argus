# Changelog

All notable changes to Argus are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are cut by hand; see
[`docs/RELEASING.md`](./docs/RELEASING.md).

## [Unreleased]

Nothing has been published to npm yet. Everything below is on `main`.

### Added

- Single npm package with subpath exports, built as both ESM and CommonJS.
- Open-source baseline: `README.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `docs/THREAT-MODEL.md`,
  `docs/LIMITS.md`, issue and pull request templates.
- CI: format, lint, typecheck, test, build, action-pin checks, CodeQL and gitleaks.
- Manual release process with npm Trusted Publishing and provenance.
- Agent: event loop delay and memory samplers driven by a sampler controller.
- Agent: NDJSON export stream with bounded, drop-oldest backpressure, to stdout or a file.
- Agent: configuration from `ARGUS_*` environment variables and `argus.config.{js,json}`.
- Agent: GC sampler (count and pause times by kind) from `PerformanceObserver`.
- Agent: stream backpressure probe that reports stalled writes by call site.
- Agent: `require('argus/agent')` / `import 'argus/agent'` (or `--require`/`--import`) starts the
  agent once per process.
- Agent: automatic trace id per incoming `node:http`/`node:https` request through
  `AsyncLocalStorage`, honouring an incoming W3C `traceparent`; `currentTraceId()`.
- Agent: V8 heap space statistics in every sample and on-demand heap snapshots
  (`takeHeapSnapshot`).
- Agent: on-demand allocation sampling through the inspector (`sampleAllocations`).
- Agent: a parser for `node --trace-deopt` output (`createDeoptParser`). It does not capture the
  output itself.
- Agent: runs under the Node permission model; a denied grant disables only that feature with a
  typed `ArgusPermissionError`; `isPermissionModelEnabled()` and `checkPermission()`.
- Agent: HTTP spans exported as NDJSON lines next to samples.
- Collector (`argus/collector`): fixed time windows with integer math and ring buffers of recent
  windows, alerts and spans.
- Collector: window-based alerts with per-metric thresholds.
- Collector: alert sinks for stdout, a file and a webhook (Node core `fetch`).
- Collector: opt-in persistence of recent windows to an append-only file, restored on start.
- Dashboard (`argus/dashboard`): SSE server with token gating for non-loopback binds.
- Dashboard: vanilla-JS live page with event loop, memory, GC, alerts and a trace waterfall of
  recent requests.
- Analyzer (`argus/analyzer`): Worker Thread pool with heap-snapshot summaries and diffs.
- Analyzer: source-map stack-trace symbolization on the worker pool.
- Plugin runner (`argus/plugin-runner`): user rules in an `isolated-vm` sandbox in a child process,
  with a memory limit and a timeout.
- Plugin runner: built-in rules (event loop lag, GC pause share, heap growth) and
  `loadRulesDirectory`.
- OpenTelemetry (`argus/otel`): opt-in OTLP/HTTP JSON export of windows as metrics and spans as
  traces.
- Examples: `examples/express-app` (agent in the app, collector and dashboard in a second process)
  and `examples/worker-pool`.
- Agent: every sample line carries cumulative `dropped: { samples, spans }` loss counters.
- Agent: `createDeoptParser({ maxEvents, maxLineLength })` and `droppedEvents()`.
- Agent: `createSamplerController(onSample, { onError })`; new `ArgusSamplerWarning` and
  `ArgusBackpressureWarning` process warnings.
- Dashboard: `allowedHosts` option for names the dashboard is reached by (reverse proxy, container
  port mapping).
- Collector and OpenTelemetry: `closeTimeoutMs` option on the webhook sink and the OTLP exporters;
  `WindowStore.close()`.
- Analyzer: `maxSnapshotBytes` option (default 256 MiB) and `HeapSnapshotTooLargeError`
  (`ERR_HEAP_SNAPSHOT_TOO_LARGE`); `DEFAULT_RESOURCE_LIMITS`, `DEFAULT_MAX_SNAPSHOT_BYTES`.
- Analyzer: symbolizer `roots` option (reads confined by `realpath`) and `maxFileBytes` (default
  64 MiB); `DEFAULT_MAX_SOURCE_FILE_BYTES`.
- Plugin runner: `maxFindings` (default 10 000) and `maxResultBytes` (default 1 MiB) options.
- `bench/overhead.mjs` (agent-on versus agent-off benchmark), `bench/soak.mjs` (leak checks under
  load) and a nightly workflow that runs both.
- CI: `npm run check:package` in the Build job checks the tarball contents and that
  `engines.node` matches `.nvmrc`.

### Changed

- `engines.node` is now `>=22.18.0`, and `.nvmrc` pins `22.18.0`; required CI jobs run on that
  floor.
- The package no longer ships declaration maps or the analyzer test fixture; `.js.map` files embed
  their sources.
- Agent: an unknown `ARGUS_*` variable prints one warning on stderr and is ignored, instead of
  disabling the agent.
- Agent: samples and spans are queued in separate lanes, each bounded by `queueBound`; sample lines
  are written first.
- Agent: the backpressure probe also covers `Duplex`, `Transform`, `PassThrough`, `net.Socket`,
  `tls.TLSSocket`, `http.ServerResponse` and `http.ClientRequest`.
- Agent: an ESM and a CJS copy of the agent share one set of prototype wrappers.
- Agent: `traceparent` with an all-zero parent id starts a new trace; versions other than `00` are
  parsed with the `00` layout.
- Dashboard: requests whose `Host` is not allowed get `421`; a cross-origin `Origin` on `/events`
  or a non-GET request gets `403`.
- Dashboard: `?token=` is accepted only on `GET /` and exchanged for an `HttpOnly`,
  `SameSite=Strict` cookie; assets and `/events` take the cookie or `Authorization: Bearer`.
- Dashboard: malformed-request warnings are rate-limited to one report plus one summary per 10 s;
  client resets are not reported.
- Collector and OpenTelemetry: `close()` waits at most `closeTimeoutMs`, then drops queued batches
  and aborts in-flight requests, counting both.
- Collector: `collector.close()` closes the sinks first and latches the window store.
- Analyzer: every pool worker runs with `resourceLimits` (default 512 MiB old, 64 MiB young
  generation).
- Analyzer: the heap-snapshot worker streams the file; snapshots must list `snapshot`, `nodes` and
  `strings` in V8's order and have at most 262 144 distinct object names.
- Analyzer: workers no longer inherit entry-point flags such as `--input-type`, `-e` or
  `--inspect`.
- Plugin runner: the sandbox child receives the host's `--permission`, `--experimental-permission`
  and `--allow-*` flags.

### Fixed

- Agent: requests that arrive while the agent configuration loads are traced.
- Agent: spans no longer evict metric samples from the output queue under load.
- Agent: disabling the backpressure probe or tracing never leaves a throwing `write` or `emit`
  behind and never removes a wrapper another library installed later.
- Agent: the stream `write` wrappers keep the original arity (`write.length === 3`).
- Agent: a throwing `onSample` callback no longer becomes an uncaught exception.
- Agent: the deopt parser no longer keeps every event forever.
- Analyzer: an oversized heap snapshot can no longer abort the host process with a fatal
  out-of-memory error.
- Analyzer: a host started with `--input-type=module -e` can start analyzer workers.
- Collector: `append()` after `collector.close()` no longer reopens the persistence file.
- Dashboard: a stalled SSE client no longer retains dropped events.

### Security

- Dashboard: `Host`/`Origin` allowlist against DNS rebinding.
- Dashboard: the token no longer appears in page, asset or SSE URLs; the session cookie holds an
  HMAC of the token, not the token. `/events` and error responses send `nosniff`, a
  `default-src 'none'` CSP and `Referrer-Policy: no-referrer`.
- Collector and OpenTelemetry: webhook and OTLP requests never follow redirects (a 3xx is a failed
  delivery) and read at most 64 KiB of a response body.
- Files the agent, the window store and the file alert sink create are mode `0600`.
- Analyzer: symbolizer parse errors no longer quote file content.
- Plugin runner: rule results are capped in the child and validated on the host; rule error
  messages are cut to 4 096 characters.
