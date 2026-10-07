# Argus — Limits

What Argus does **not** guarantee, stated plainly. Argus is pre-release (S0 to S7 implemented, not
yet published). These are the design's inherent limits and the known gaps in what is built. For the
security design see [`THREAT-MODEL.md`](./THREAT-MODEL.md).

## 1. Cost and overhead

- **Overhead is measured, never zero.** `bench/overhead.mjs` compares agent-off with the agent
  loaded but disabled, the full agent, tracing only and samplers only, on HTTP workloads
  (`trivial`, `promise`, `cpu`, `stream`). A nightly workflow runs it; the results are
  informational and nothing fails on a regression. Numbers depend on the workload and the machine:
  run it on yours (see [`bench/README.md`](../bench/README.md)).
- **Tracing is where the per-request cost is.** Each traced request runs inside an
  `AsyncLocalStorage` context and keeps a small record until its response finishes. The samplers
  and the backpressure probe add a fixed cost per interval and a few nanoseconds per stream write.
- **Node 22 makes tracing more expensive.** On Node 22, `AsyncLocalStorage` is built on
  `async_hooks` promise hooks, so once tracing is on every promise in the process pays for it, and
  promise-heavy handlers can lose a large share of their throughput. Node 22's
  `--experimental-async-context-frame` flag switches to the implementation Node 24 uses by default.
  Compare on your workload with
  `node bench/overhead.mjs --workloads promise --node-arg=--experimental-async-context-frame`.
- **The default output shares your stdout.** With no configuration the agent writes about 2 KB per
  sample (one per second) plus one line per traced request to the process's stdout, interleaved
  with your own output. Set `ARGUS_OUTPUT` to a file path, or to `none`, if that matters.
- **Heap snapshots pause the process.** Taking one blocks the event loop and can need as much memory
  again as the heap holds. On a large heap in a memory-constrained container, that can end in an OOM
  kill. Snapshots are opt-in and manual for this reason.
- **Analysis in Worker Threads is isolated from the event loop, not free.** Workers use CPU and memory
  of the same machine and can still slow the host through contention. Each analyzer worker may use
  up to its `resourceLimits` (default 512 MiB old generation, 64 MiB young generation).

## 2. In-process, so shared fate

- **If the host dies, Argus dies with it,** and so does the in-memory data. The ring buffer is lost
  on a crash or restart unless opt-in disk persistence is on, and persistence keeps only recent
  windows, not history.
- **Data is dropped, not queued without limit.** The agent's sample and span output lanes each
  hold `queueBound` lines (default 1024) and drop the oldest; the span buffer holds 1024 spans
  between ticks. Above roughly 1000 requests per sampling interval, spans are dropped. Every sample
  line carries cumulative `dropped: { samples, spans }` counters; the collector and dashboard do not
  display them yet.
- **Event loop lag is observed by the loop itself.** A loop blocked completely cannot report
  until it resumes, so the longest stalls are reported late, with their full length.
- **Argus cannot protect itself from the host.** Code running in the same process can read or alter
  Argus's data. It is a diagnostic tool, not a tamper-evident audit log.

## 3. What the data can and cannot tell you

- **Only incoming HTTP requests are traced.** Requests to `node:http` and `node:https` servers get a
  trace id and a span. Outgoing requests, HTTP/2, database calls and queue consumers get no span of
  their own; work they do inside a traced request sees that request's trace id.
- **Trace context can be lost.** `AsyncLocalStorage` propagates through promises and most callbacks,
  but not across every native addon, connection pool or queue, and not across processes. Spans can
  be missing or attached to the wrong request. Worker Threads need explicit propagation.
- **No distributed tracing.** An incoming W3C `traceparent` is honoured, but Argus does not add one
  to outgoing requests, so it does not follow a request across services.
- **Backpressure hotspots are inferred from `write()` returning `false`.** The probe wraps `write`
  on the `Writable`, `Duplex` and `http.OutgoingMessage` prototypes, which covers `Writable`
  subclasses, `fs.WriteStream`, `Duplex`, `Transform`, `PassThrough`, `net.Socket`,
  `tls.TLSSocket`, `http.ServerResponse` and `http.ClientRequest`. A socket stall inside
  `res.write()` is counted once, on the response. Writes Node makes internally (such as the data
  passed to `res.end(data)`) show up as socket stalls. A stream class that overrides `write`
  without calling the prototype's is not seen. Hotspots point to where to look, not to a proven
  root cause.
- **Windows are aggregates.** Percentiles over a time window hide what happened inside it, and
  counters use integer math, so very small or very large values are bounded by the unit chosen.
- **GC and deoptimization detail depend on Node and V8.** GC data comes from `PerformanceObserver`
  `gc` entries, whose detail varies by Node version. Deoptimization support is a parser for
  `node --trace-deopt` output: Argus does not start or capture that output, and the text format can
  change between V8 versions. Argus targets the Node versions in `package.json`'s `engines` field
  and may report less on others.
- **Heap-snapshot analysis has caps.** Files over `maxSnapshotBytes` (default 256 MiB) are refused
  before reading. The streaming parser needs the top-level keys in V8's order (`snapshot`, `nodes`,
  `strings`), keeps at most 262 144 distinct object names, and truncates names over 1 KiB.
  Source files and maps over `maxFileBytes` (default 64 MiB) are not symbolized.

## 4. Security limits

- **No TLS.** The dashboard is plain HTTP. Remote access needs an authenticated tunnel or a
  reverse proxy. The token gate stops casual access, not a network attacker.
- **The browser token flow assumes a direct link.** The `?token=` link sets a `SameSite=Strict`
  cookie. If you click that link on another website, some browsers leave the cookie off the
  redirected request and the first load shows `401`; reloading `/` works. Opening the link from
  the address bar, a terminal or a bookmark is not affected.
- **There is no redaction step.** Argus records method, path without query string, status and
  timing, and nothing else from a request. A secret in a path segment is recorded as is.
- **Sandboxed rules are limited, not safe.** `isolated-vm` constrains memory, time, result size and
  reach, but it is a defense in depth, not a guarantee. Load only rules you would run anyway.
- **Worker memory limits are best-effort for custom workers.** A worker file that makes one large
  native allocation (for example `JSON.parse` of a big string) can exceed its `resourceLimits` far
  enough to abort the whole process. The analyzer's own workers cap their input to avoid this.

## 5. Packaging

- **ESM and CJS can both be loaded.** The package ships both formats. If an application loads
  `argus/agent` once through `import` and once through `require`, it gets two copies of the module
  (the "dual package hazard"). The agent itself starts only once per process, and the two copies
  share one set of prototype wrappers through `globalThis` registries, so disabling either copy, in
  any order, leaves `write` and `emit` working and restores the prototypes when the last one is
  disabled. Each copy still keeps its own samples, spans and trace context. Pick one format per
  process.
- **Platform.** Argus is developed and tested on Linux and macOS. Other platforms are not covered
  by CI.
