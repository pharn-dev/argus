---
spec_id: agent-ndjson-export
state: Approved
spec_content_hash: 5924933b8cce442b0f1706027cc9d337dce8ed864b486fc8ea88096ca054f38a
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S1 (agent core), second slice. The agent already produces samples (event loop lag and
memory, through the sampler controller), but nothing leaves the process yet. A developer running the agent
needs those samples written out as NDJSON to a destination they choose (a file, stdout), and needs the
agent to stay safe when that destination is slow: memory must not grow without limit, records lost to a
slow consumer must be counted rather than silently vanish, and a broken destination must be reported
rather than swallowed. This slice gives the agent that export path so the collector and dashboard slices
have a stream to consume.

## Scope

**In scope:**

- An NDJSON encoder that turns each sample or event object into exactly one JSON line terminated by `\n`.
- Backpressure handling: the exporter respects the destination's `write()` return value and `'drain'`;
  while the consumer is slow it keeps records in a bounded queue and drops the oldest records beyond the
  bound, counting every dropped record in an integer counter that callers can read.
- An exporter that connects the sampler controller's samples to a caller-supplied Writable (no default
  destination), built on `stream/promises` `pipeline()`, never `.pipe()`, with explicit error handling: a
  destination error stops the exporter and is surfaced to the caller.
- All of it exported from `src/agent/index.ts`, using Node core only, with vitest tests.

**Out of scope (non-goals):**

- Configuration loading and options beyond the queue bound and the destination.
- GC event sampling.
- Backpressure probes for user streams.
- The `require('argus/agent')` / `--require` entry point.
- Any network transport, SSE, or collector-side parsing of the NDJSON.

## Acceptance Criteria

- **AC-1** Given an exporter imported from the agent entrypoint and connected to a Writable that records
  every byte it receives When three distinct plain objects are exported and the exporter is then stopped
  Then the recorded bytes split on `\n` into exactly three non-empty lines followed by a final `\n`, and
  `JSON.parse` of each line deep-equals the corresponding input object, in the order exported
  - verify: unit
- **AC-2** Given an exporter with a queue bound of N connected to a Writable that accepts no further data
  until it is resumed (its `write()` returns false and it emits no `'drain'`) When more than N records
  beyond what the destination already accepted are exported Then the exporter's exposed dropped counter
  is an integer equal to the total exported minus the records the destination accepted minus N, and after the destination is resumed and the exporter stopped, the lines it receives after the stall
  are exactly the newest N records in export order, with every older stalled record absent
  - verify: unit
- **AC-3** Given a sampler controller connected through an exporter to a Writable destination When the
  controller runs for a few intervals and the destination then emits an error Then each line written
  before the error parses as a sample with an integer timestamp and event loop and memory parts, the
  exporter's completion promise rejects with that same error, and no further sample reaches the
  destination after the rejection
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party and zero workspace dependencies.
- Stream wiring uses `stream/promises` `pipeline()`; no `.pipe()` call anywhere in the slice.
- No silent failures: every stream error is either surfaced to the caller or rethrown, never swallowed.
- The dropped counter is an integer; memory held by the exporter is bounded by the queue bound.
- No `async_hooks` import in this slice.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results already configured; the test stage's preflight decides whether that holds.
- "Exposed dropped counter" means a readable integer property or getter on the exporter; a periodic meta
  line in the NDJSON output is not required by this slice. The exact name is left to the PLAN.
- Records the destination has already accepted (written while `write()` still returned true, or held in
  its own buffer) are not counted as queued or dropped; only records held in the exporter's own bounded
  queue are subject to the bound.
- Dropping oldest-first means the newest N records survive a stall; this is the user's stated policy.
- The exporter exposes a completion promise (the `pipeline()` result) that resolves on a clean stop and
  rejects with the destination's error; the exact method names (`stop`, `done`, etc.) are left to the PLAN.
- On a destination error the exporter stops pulling samples (it stops or detaches from the controller);
  whether it also stops the controller itself is left to the PLAN, as long as no further sample reaches
  the destination.
- The default queue bound, when the caller passes none, is a PLAN choice; the criteria pass N explicitly.
- Objects that cannot be serialised by `JSON.stringify` (cycles, BigInt) are not produced by the samplers;
  how the encoder handles them is left to the PLAN, provided the failure is surfaced, not swallowed.
