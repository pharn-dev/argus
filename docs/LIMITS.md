# Argus — Limits

What Argus does **not** guarantee, stated plainly. Argus is pre-release, so these describe the
design's inherent limits, not bugs to be fixed later. For the security design see
[`THREAT-MODEL.md`](./THREAT-MODEL.md).

## 1. Cost and overhead

- **Overhead is measured, never zero.** Tracking a `traceId` across async work uses
  `AsyncLocalStorage` and `async_hooks`, which add cost to every promise and async resource, and
  the cost grows with async depth. Hot-path changes carry an agent-on vs agent-off benchmark, but
  the result depends on the workload. Measure it on yours.
- **Heap snapshots pause the process.** Taking one blocks the event loop and can need as much memory
  again as the heap holds. On a large heap in a memory-constrained container, that can end in an OOM
  kill. Snapshots are opt-in and manual for this reason.
- **Analysis in Worker Threads is isolated from the event loop, not free.** Workers use CPU and memory
  of the same machine and can still slow the host through contention.

## 2. In-process, so shared fate

- **If the host dies, Argus dies with it,** and so does the in-memory data. The ring buffer is lost
  on a crash or restart unless opt-in disk persistence is on, and persistence keeps only recent
  windows, not history.
- **Event loop lag is observed by the loop itself.** A loop blocked completely cannot report
  until it resumes, so the longest stalls are reported late, with their full length.
- **Argus cannot protect itself from the host.** Code running in the same process can read or alter
  Argus's data. It is a diagnostic tool, not a tamper-evident audit log.

## 3. What the data can and cannot tell you

- **Trace context can be lost.** `AsyncLocalStorage` propagates through promises and most callbacks,
  but not across every native addon, connection pool or queue, and not across processes. Spans can
  be missing or attached to the wrong request. Worker Threads need explicit propagation.
- **No distributed tracing.** A `traceId` identifies work inside one process. Argus does not follow
  a request across services.
- **Backpressure hotspots are inferred.** They come from stream state and timing, so they point to
  where to look, not to a proven root cause.
- **Windows are aggregates.** Percentiles over a time window hide what happened inside it, and
  counters use integer math, so very small or very large values are bounded by the unit chosen.
- **Deoptimization and GC detail depend on Node and V8.** They rely on `--trace-gc` and
  `--trace-deopt` output, whose format can change between Node versions. Argus targets the Node
  versions in `package.json`'s `engines` field and may report less on others.

## 4. Security limits

- **No TLS.** The dashboard is plain HTTP. Remote access needs an authenticated tunnel or a
  reverse proxy. The token gate stops casual access, not a network attacker.
- **Redaction is best effort.** Defaults cover common credentials; they cannot know what is
  sensitive in _your_ application.
- **Sandboxed rules are limited, not safe.** `isolated-vm` constrains memory, time and reach, but it
  is a defense in depth, not a guarantee. Load only rules you would run anyway.

## 5. Packaging

- **ESM and CJS can both be loaded.** The package ships both formats. If an application loads
  `argus/agent` once through `import` and once through `require`, it gets two copies of the module
  and two copies of its state (the "dual package hazard"). Pick one format per process.
- **Platform.** Argus is developed and tested on Linux and macOS. Other platforms are not covered
  by CI.
