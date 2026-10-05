---
spec_id: analyzer-worker-pool
state: Approved
spec_content_hash: 438827a9fd0efb534bd1a51e0fb22f6a7d0bf85c0c5af1ab4853b1569049722f
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S5 (V8 / memory depth), analyzer slice 1 (FEATURES.md §3 "Heap-snapshot diffing" and §7
"Heap-snapshot analysis off the monitored event loop", "Worker pool for parallel profile processing"). The
`argus/analyzer` entrypoint is still a scaffold placeholder. A user chasing a memory leak at 2am needs to
take two heap snapshots and see which constructors grew, without loading a multi-megabyte snapshot into the
monitored process's event loop and without installing a separate tool. This slice replaces the placeholder
with a fixed-size Worker Thread pool that runs CPU-heavy tasks off the caller's event loop, plus two tasks
run in it: a heap-snapshot summary and a heap-snapshot diff.

## Scope

**In scope:**

- A fixed-size worker pool created from a size and a worker file (for example
  `createWorkerPool({ size, workerFile })`): a bounded task queue, each task dispatched to an idle worker,
  each task's result or error returned as a promise; a worker that crashes is replaced and its in-flight
  task rejected with the error; a per-task timeout terminates and replaces the worker and rejects that task;
  `close()` terminates every worker and rejects every queued task.
- Worker file resolution that works in the ESM build (`dist/esm`), the CJS build (`dist/cjs`) and under
  vitest.
- A heap-snapshot summary task run in that pool: given the path of a `.heapsnapshot` file (V8 JSON format:
  `snapshot.meta.node_fields` / `node_types`, `nodes`, `strings`), it returns the total node count, the total
  self size, and the top N node names (constructors / types) ranked by aggregated self size, all integers.
- A heap-snapshot diff task run in that pool: given two snapshot paths, it returns per-name count and
  self-size deltas, largest growth first, limited to the top N.
- Everything exported from `src/analyzer/index.ts`, with vitest tests that generate small real snapshots with
  `v8.writeHeapSnapshot` into a temporary directory, and a test worker file under `src/analyzer/workers/` that
  can crash or hang on demand.

**Out of scope (non-goals):**

- Taking heap snapshots on demand from the agent, or wiring the analyzer into the agent, collector or
  dashboard.
- Retained-size (dominator tree) computation, edge or retainer-path analysis, or stack-trace symbolization.
- Allocation timeline, sampling profiler capture, `--trace-deopt` parsing, or `v8.getHeapSpaceStatistics()`
  exposure.
- Streaming parsing of snapshots larger than a worker can hold in memory.
- `examples/worker-pool`.

## Acceptance Criteria

- **AC-1** Given a worker pool of size 1 created from the analyzer entrypoint over a test worker file under
  `src/analyzer/workers/` that echoes its input, crashes, or never answers depending on the task When an echo
  task is run, then a crash task, then a task that never answers with a per-task timeout of a few hundred
  milliseconds, then another echo task, and finally two tasks are queued and the pool is closed before they
  run Then the first echo resolves with its input, the crash task rejects with an error, the hanging task
  rejects with a timeout error, the echo after them resolves with its input (the worker was replaced each
  time), and both queued tasks reject after `close()` with no unhandled rejection
  - verify: integration
- **AC-2** Given a heap snapshot written with `v8.writeHeapSnapshot` into a temporary directory while the test
  process holds 10000 instances of a uniquely named class When the summary task is run through the analyzer
  entrypoint on that file with a top N of 50 Then it resolves with a total node count and total self size that
  are positive integers, a top list of at most 50 entries ordered by self size descending whose counts and
  sizes are integers, and an entry named after that class with a count of at least 10000
  - verify: integration
- **AC-3** Given two heap snapshots written with `v8.writeHeapSnapshot` into a temporary directory, the second
  taken after the test process has allocated and still holds 5000 instances of a uniquely named class that
  did not exist at the first When the diff task is run through the analyzer entrypoint on the two paths with
  a top N of 20 Then it resolves with at most 20 entries ordered by self-size delta descending, all deltas
  are integers, and the entry named after that class has a count delta of at least 5000 and a positive
  self-size delta
  - verify: integration

## Constraints

- `src/analyzer` uses Node core modules only (`node:worker_threads`, `node:fs`, …): no third-party
  dependencies, and no imports from `src/agent` or any other module.
- All Worker Thread files live in `src/analyzer/workers/`; no inline or `eval`-based workers.
- Every worker, task and file read has explicit error handling: no silent failures, no swallowed rejections,
  no unhandled rejections.
- Counts and sizes are integers.
- Snapshot parsing runs in a worker, never on the caller's event loop.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build and
  `check:exports` must keep passing.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results already
  configured; the test stage's preflight decides whether that holds.
- "Top N constructors by retained-by-self size" means aggregated `self_size` per node name, not V8 retained
  size; the description defines it that way.
- The task queue's bound and the behaviour when it is full (reject the new task with an error) are chosen by
  the PLAN; the default per-task timeout is a finite value chosen by the PLAN.
- The pool's public names (`createWorkerPool`, `run`, `close`, `summarizeHeapSnapshot`,
  `diffHeapSnapshots`, or similar) and the result object field names are picked by the PLAN.
- The summary and diff tasks may create and close their own pool or accept an existing one; either satisfies
  the criteria as long as parsing happens in a worker.
- Under vitest the worker file may be resolved to its TypeScript source; making that loadable (for example
  through Node's type stripping or a test-only resolution) is a PLAN decision.
- The diff's growth ordering is by self-size delta; entries that shrank may appear after those that grew.
