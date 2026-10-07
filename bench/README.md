# bench/

Two maintained harnesses that keep the agent's overhead and resource claims checkable:

- `overhead.mjs` — agent-on versus agent-off HTTP benchmark.
- `soak.mjs` — long run under load that fails on leaks.

Both use Node core only (no dependencies, like the agent). They measure the **built package**:
the targets load `argus/agent` through the package's own `exports` (self-reference by package
name), which is exactly what a user's `--import argus/agent` loads. Build first:

```bash
npm ci
npm run build
```

Like `scripts/*.mjs`, these files are plain ESM JavaScript: `npm run lint` covers them,
`npm run typecheck` (which checks `.ts` only) does not.

## Overhead benchmark

```bash
node bench/overhead.mjs                       # full run, about 8 minutes
node bench/overhead.mjs --duration 3 --rounds 1 --warmup 1   # quick look, about 1.5 minutes
```

| Flag            | Default                           | Meaning                                                      |
| --------------- | --------------------------------- | ------------------------------------------------------------ |
| `--duration`    | `5`                               | measured seconds per cell                                    |
| `--warmup`      | `1.5`                             | seconds of load before measuring                             |
| `--connections` | `32`                              | concurrent keep-alive connections                            |
| `--rounds`      | `3`                               | interleaved rounds; every number is the median across rounds |
| `--workloads`   | `trivial,promise,cpu,stream`      | comma list                                                   |
| `--variants`    | `none,idle,full,tracing,samplers` | comma list                                                   |
| `--out`         | a file in the OS temp directory   | where the JSON result goes                                   |
| `--node-arg`    | none                              | extra Node flag for every target, repeatable                 |

**How it works.** For each cell (workload × variant × round) a fresh target process starts an
HTTP server on loopback. The harness drives it closed-loop: `--connections` keep-alive sockets,
each with one request in flight, request paths cycling over 50 values, one request in seven
carrying a W3C `traceparent`. After the warm-up the target is told to start measuring, and after
`--duration` to stop. Within a round the variants of a workload run back to back, and the variant
order rotates from round to round, so slow drift on the host does not always hit the same variant.

**Workloads**

| Workload  | Per request                                                                       |
| --------- | --------------------------------------------------------------------------------- |
| `trivial` | `res.end('ok')`                                                                   |
| `promise` | a chain of 20 `await`s, then respond (AsyncLocalStorage propagation cost)         |
| `cpu`     | 20 000 integer operations, then respond                                           |
| `stream`  | 4 KiB through a `Transform` into the response with `stream/promises` `pipeline()` |

**Variants**

| Variant    | What is loaded                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `none`     | nothing: the baseline                                                                               |
| `idle`     | `--import argus/agent` with `ARGUS_ENABLED=false`: installed, switched off by config                |
| `full`     | `--import argus/agent` with its defaults: tracing and every sampler, NDJSON to stdout (`/dev/null`) |
| `tracing`  | library API only: HTTP tracing on, spans flushed once a second to `/dev/null`; no samplers          |
| `samplers` | library API only: samplers and the backpressure probe at 1 s, to `/dev/null`; tracing off           |

**What is measured.** On the load generator: requests per second and the p50/p99 latency, from
the HDR histogram in `node:perf_hooks`. In the target, for the measured window only: CPU time
(`process.cpuUsage`, reported per request and as % of one core), event-loop utilisation
(`performance.eventLoopUtilization`), RSS at the end, and GC count and total pause
(`PerformanceObserver` on `gc` entries).

**Reading the tables.** Each workload gets one table on stdout (Markdown, so it pastes into a PR
or a job summary as is). Every value is the median across rounds; `±` after rps is the coefficient
of variation across rounds; percentages in parentheses are the change versus `none`.

- Where the server has spare CPU (ELU well below 1), the cost shows up as **CPU µs/req**, not as
  throughput or latency. Where it is saturated (ELU ≈ 1), it shows up as lower rps and higher p50.
- `idle` should be indistinguishable from `none`. `full` ≈ `tracing` + `samplers`; tracing is
  where the per-request cost is.
- On Node 22, `AsyncLocalStorage` rides on `async_hooks`, so `promise` under `full`/`tracing` is
  much slower than on Node 24. Compare with
  `--node-arg=--experimental-async-context-frame` to see the Node 24 profile on Node 22.

**Noise.** Treat a delta smaller than about twice the CV as noise. On a quiet machine the rps CV
is 1–2 % for `trivial`, `promise` and `cpu`; on shared CI runners expect **CV 3–8 %** on rps and
more on p99. `stream` is the noisiest workload. A loaded laptop (other builds, a browser) makes
every number unreliable; the JSON records the load average at the start so you can tell.

**Exit code.** 0 when every cell ran; 1 when the harness broke (a target crashed, a request
failed, the agent reported itself disabled on stderr). The numbers never fail the run.

**JSON.** One file per run: run metadata (commit, Node version, platform, CPU, load average,
settings), `summary[workload][variant][metric]` with `median`, `min`, `max`, `cv` and `n` plus
`deltaVsNone`, and every raw cell under `cells`.

## Soak test

```bash
node bench/soak.mjs                    # 120 s
node bench/soak.mjs --duration 30      # quick run; the heap baseline moves to 7.5 s
```

Three processes for the whole run:

1. **App** — `node --expose-gc --import argus/agent` with `ARGUS_INTERVAL_MS=100` and
   `ARGUS_OUTPUT=stdout`, serving a mix of the benchmark workloads under closed-loop load
   (`--connections`, default 8). Every request path is unique, and one request in eight stalls a
   `Writable`, so the backpressure probe churns too.
2. **Collector** — `node --expose-gc`, reading the app's NDJSON (piped through the harness) into
   `argus/collector`, and keeping every other module busy:
   - `argus/dashboard` serves it to SSE clients: `--sse-concurrency` loops (default 10) that
     connect, read for 20–300 ms and hang up, plus `--stalled-clients` (default 5) that connect at
     the start and never read until the end;
   - `argus/otel` metric and trace exporters flood a dead endpoint (500 batches per 100 ms each);
   - `argus/analyzer` symbolizes twice a second, on a persistent pool and every fourth time on a
     fresh pool (a Worker created and terminated per call);
   - `argus/plugin-runner` runs the built-in rules every second, plus a rule that times out every
     fifth run (the sandbox child is killed and respawned).
3. **Harness** — load generator, SSE clients, and the checks.

Heap-after-GC (`gc()` with `--expose-gc`, minimum of three readings) is taken in both processes
at the baseline (`--baseline`, default `min(30 s, duration / 4)`) and at the end, while the load
is still running. Then everything is closed and the run **fails (exit 1)** if:

- heap-after-GC grew more than `--max-heap-growth` (default 10 %) in either process;
- a Worker thread or child process outlived its owner's `close()` (counted in-process and with
  `pgrep -P`);
- the dashboard still has clients after every client hung up;
- any HTTP request or SSE connection failed;
- either process did not exit on its own once closed (a leaked handle), or exited non-zero;
- the agent reported itself disabled on stderr, or the NDJSON pipe failed;
- either process's heap passed `--heap-ceiling` (default 512 MiB) at a 5 s probe — the run stops
  early rather than exhaust the machine.

The lines after the table are informational: request rate, SSE cycles and dropped events,
NDJSON lines and windows received (fewer windows than expected means agent samples were lost on
the way), exporter drops and failures, analyzer and plugin-runner outcomes, and the first error
of each kind. `--out` also writes everything as JSON.

## In CI

`.github/workflows/nightly.yml` runs both daily (and on demand via `workflow_dispatch`) on the
Node floor from `.nvmrc`, as two non-required jobs:

- **Nightly benchmark** — informational. Tables in the job summary, JSON uploaded as the
  `overhead-benchmark` artifact (kept 90 days) for comparing runs over time.
- **Nightly soak** — fails the workflow on a leak (exit 1 above).

The benchmark does not run on pull requests: shared-runner noise (CV 3–8 %) is larger than most
real regressions, so it would block PRs on noise. If a PR touches a hot path (the HTTP wrapper,
the write wrapper, the samplers, the exporter), run it locally before and after the change and
put both tables in the PR.

A release gate is a later decision. When there is one, it is meant to be run as:

```bash
node bench/overhead.mjs --rounds 5 --workloads trivial,promise --variants none,full --out release.json
```

and to compare the `full` versus `none` p50 and CPU µs/req deltas against the trailing median of
the nightly artifacts, not against a fixed number.
