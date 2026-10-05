---
spec_id: agent-ndjson-export
spec_content_hash: 5924933b8cce442b0f1706027cc9d337dce8ed864b486fc8ea88096ca054f38a
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `agent-ndjson-export` (ROADMAP S1, second slice).

Discovery (live, this run): the repo is a single npm package with modules under `src/<module>/`, built to
`dist/esm` and `dist/cjs` by `scripts/build.mjs` and exported as `argus/agent`. `vitest.config.mts` collects
`src/**/*.test.ts`. `eslint.config.mjs` limits non-test `src/agent/**/*.ts` to `node:` builtins and relative
imports. `src/agent/index.ts` currently re-exports the samplers and `createSamplerController(onSample)`, whose
`onSample(sample: AgentSample)` callback is the only way samples leave the controller, and keeps the
`ArgusAgentPlaceholder` type that `src/collector/index.ts` imports. The controller's `setInterval` is unref'd.

The slice adds three small modules (one reason to change each) and re-exports them from the entrypoint.

1. **NDJSON encoder** (`src/agent/ndjson-encoder.ts`): `encodeNdjsonLine(record: unknown): string` returns
   `JSON.stringify(record) + '\n'`.
   - `JSON.stringify` already throws on a cycle or a BigInt; that `TypeError` propagates unchanged (surfaced,
     never swallowed).
   - When `JSON.stringify` returns `undefined` (the input is `undefined`, a function or a symbol), it throws a
     `TypeError` itself, so a record never silently turns into nothing.
   - `JSON.stringify` escapes control characters, so a line never contains a raw `\n`: one record is always
     exactly one line.
2. **Bounded drop-oldest queue** (`src/agent/bounded-queue.ts`): `createBoundedQueue<T>(capacity: number)`
   returns `{ push(item: T): boolean; shift(): T | undefined; readonly length: number }`.
   - A fixed-size ring buffer (an array of `capacity` slots plus integer `head` and `length`), so memory is
     bounded by `capacity` and both operations are O(1) integer index math.
   - `push` on a full queue overwrites the oldest slot, advances `head`, and returns `true` to say "one item was
     evicted"; otherwise it returns `false`. `shift` clears the slot it reads so the evicted or consumed record
     can be garbage collected.
   - `capacity` must be a positive safe integer, else `RangeError`.
3. **Exporter** (`src/agent/ndjson-exporter.ts`):
   `createNdjsonExporter(destination: Writable, options?: { queueBound?: number }): NdjsonExporter` where

   ```ts
   type NdjsonExporter = {
     /** Encode one record and queue it for the destination. */
     export(record: unknown): void;
     /** Integer count of records discarded without reaching the destination. */
     readonly dropped: number;
     /** Flush the queue, end the destination, and return `done`. */
     stop(): Promise<void>;
     /** The pipeline() result: resolves on a clean stop, rejects with the destination's error. */
     readonly done: Promise<void>;
   };
   ```

   - `queueBound` defaults to `1024` (a PLAN choice the SPEC left open) and must be a positive safe integer,
     else `RangeError` from the factory. `Writable` is the `node:stream` type; a file stream from
     `fs.createWriteStream` and `process.stdout` both fit.
   - **The wiring:** `done = pipeline(source(), destination)` with `pipeline` from `node:stream/promises`. The
     source is a local async generator. It loops: while the queue has a record, `yield` the next encoded line;
     when the queue is empty and the exporter is not stopping, `await` a one-shot wake promise that `export()`
     and `stop()` resolve; when the queue is empty and the exporter is stopping, `return`.
   - **Why an async generator source, not a Readable + Transform:** `pipeline()` drives an async-iterable source
     into a Writable by calling `destination.write(chunk)` and, when that returns `false`, awaiting `'drain'`
     before asking the generator for the next line. So exactly one record is "in flight" at a time, and every
     record the exporter has not handed to `write()` stays in **its own** queue. Readable and Transform stages
     would hold extra records in their own internal buffers, outside both the bound and the destination, which
     would make AC-2's exact `dropped` equation untrue and the memory bound loose. The `write()`/`'drain'`
     handling is `pipeline()`'s, not hand-written, and there is no `.pipe()` anywhere.
   - **`export(record)`:** if the exporter is closed (stopped or failed), it does not queue the record; it adds
     one to `dropped` and returns. It never throws in that case, because it is the sampler callback and a throw
     there would crash the host through `uncaughtException`; the failure itself is already surfaced through
     `done`. Otherwise it calls `encodeNdjsonLine(record)` **first** (an encode error throws synchronously to the
     caller and nothing is queued), then `queue.push(line)`; when that evicts the oldest record, `dropped += 1`.
     Then it wakes the generator. Every counter update is an integer `+ 1`.
   - **`stop()`:** marks the exporter stopping and wakes the generator. The generator drains what is left in
     the queue (through the same `write()`/`'drain'` path) and returns, and `pipeline()` then ends the
     destination and waits for `'finish'`. `stop()` returns `done`. A second `stop()` returns the same promise.
   - **On a destination error:** `pipeline()` destroys the destination and rejects `done` with that same error.
     The exporter observes the settlement internally (`done.then(onClosed, onClosed)`): it marks itself closed,
     clears the queue (adding the cleared records to `dropped`, so none vanishes uncounted) and wakes a
     generator that may still be awaiting. That internal observer only updates state; the rejection still
     reaches every caller of `done` / `stop()` unchanged (not swallowed). After that, `export()` only counts
     drops, so no further sample reaches the destination, which is AC-3.
   - The exporter does not own or stop the sampler controller. The connection is
     `createSamplerController((sample) => exporter.export(sample))`; after a failure the controller keeps
     ticking into a closed exporter until its owner calls `stop()` (the SPEC leaves this to the PLAN, provided
     nothing more reaches the destination).
4. **Entrypoint** (`src/agent/index.ts`): keep every current export and `ArgusAgentPlaceholder`; add
   `createNdjsonExporter`, `encodeNdjsonLine` and the types `NdjsonExporter` and `NdjsonExporterOptions`.
   `createBoundedQueue` stays internal (not re-exported) because no criterion needs it public. Relative
   specifiers carry the `.js` suffix, as `NodeNext` requires.

Constraints held by construction:

- Imports are `node:stream` (type only) and `node:stream/promises`, plus relative files. No third-party or
  workspace import, which the existing eslint agent rule enforces.
- No `async_hooks` import; no `.pipe()` call.
- Errors: encode errors throw to the caller; destination errors reject `done`. Nothing is caught and dropped.
- No config, script, runner or other test-infra file is touched, and no dependency is added.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`, and
  `memory-bank/lessons-learned.md` does not exist), so there are no lessons to apply.

## Steps

- Add `src/agent/ndjson-encoder.ts` with `encodeNdjsonLine`, throwing a `TypeError` when `JSON.stringify`
  returns `undefined` and letting its own errors propagate.
- Add `src/agent/bounded-queue.ts` with the ring-buffer `createBoundedQueue`, capacity validation, and a
  `push` that reports an eviction.
- Add `src/agent/ndjson-exporter.ts` with `createNdjsonExporter`, the `NdjsonExporter` and
  `NdjsonExporterOptions` types, the async-generator source, `pipeline(source(), destination)`, the
  `dropped` getter, `stop()`, `done`, and the internal settle observer that closes the exporter and counts
  cleared records.
- Update `src/agent/index.ts` to re-export the exporter, the encoder and their types, keeping all existing
  exports.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`. Both the ESM
  and CJS builds must keep compiling.

## Files

- `src/agent/ndjson-encoder.ts` — new. `encodeNdjsonLine(record)`: one JSON line plus `\n`; encode failures throw.
- `src/agent/bounded-queue.ts` — new. Fixed-capacity drop-oldest ring buffer with an eviction signal, integer index math.
- `src/agent/ndjson-exporter.ts` — new. `createNdjsonExporter(destination, { queueBound })`: async-generator source into `stream/promises` `pipeline()`, integer `dropped` counter, `stop()` and `done`.
- `src/agent/index.ts` — modified. Re-exports the exporter, the encoder and their types; keeps every existing export and `ArgusAgentPlaceholder`.

### Explicitly not touched

- `src/agent/sampler-controller.ts` — reused as is; the exporter connects through its `onSample` callback.
- `src/agent/event-loop-sampler.ts`, `src/agent/memory-sampler.ts` — reused as is.
- `src/agent/index.test.ts` and the `agent-samplers` AC tests — existing tests, left as is.
- `src/collector/index.ts` — still imports `ArgusAgentPlaceholder`, which stays exported.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`, `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (three objects exported then stopped give exactly three `\n`-terminated lines that parse back to the
  inputs in order; unit): `export()` encodes each record as one line with `encodeNdjsonLine`; the FIFO queue and
  the single generator keep export order; `stop()` drains the queue, `pipeline()` ends the destination, and
  awaiting `stop()` (or `done`) guarantees every byte reached it. Test mapping in AC-TESTS.md.
- **AC-2** (bound N, a stalled destination, `dropped === exported − accepted − N`, and after resume plus stop the
  post-stall lines are exactly the newest N in order; unit): only `pipeline()`'s pump hands records to the
  destination, one at a time, waiting for `'drain'` after a `false` from `write()`. Every record not yet handed
  over is in the exporter's ring buffer, which evicts oldest-first and counts each eviction. So
  `exported = accepted + queued + dropped`, with `queued = N` once the stall overflows the bound, which is the
  equation. After the destination is resumed (it emits `'drain'`), the pump writes the N surviving records in
  ring order, then `stop()` ends the stream.
- **AC-3** (controller → exporter → destination; the destination errors; lines before it are samples with an
  integer timestamp and event loop and memory parts; `done` rejects with that same error; nothing reaches the
  destination afterwards; integration): the controller's `onSample` is `exporter.export`, and each sample is
  encoded unchanged. `pipeline()` rejects `done` with the destination's error, and the internal observer closes
  the exporter so later `export()` calls only count drops and never write. The destination is also destroyed by
  `pipeline()`.

## Risks & open questions

- **AC-2's "accepted" must be counted by the test the same way the exporter sees it.** A record counts as
  accepted when `pipeline()` called `destination.write()` with it, including the call that returned `false`
  (it sits in the destination's own buffer, as the SPEC assumes). A test destination built as a `Writable`
  with a small `highWaterMark` whose `_write` callback is withheld during the stall fits this; `/pharn-test`
  should count accepted records in `_write`/`write()` on the destination, not infer them.
- **Exactness of the pump is Node's.** The "one record in flight" property relies on `pipeline()`'s
  async-iterable-to-Writable path awaiting `'drain'` after a `false` write (Node 22+ behavior). If a Node
  version pre-fetched from the generator, AC-2 would fail by a small constant; the AC-2 test is the check.
- **`stop()` ends the destination.** `pipeline()` calls `end()` on it on a clean stop, which closes a file
  stream. Whether `pipeline()` ends `process.stdout` is Node's stdio handling and no criterion covers it; a
  later entry-point slice should check it.
- **An unawaited `done` that rejects** becomes an unhandled rejection in the host. That is the surfaced path
  (no silent failure), but callers must await `done` or `stop()`; noted for the README in a later slice.
- **The queue bound counts records, not bytes.** A huge record still takes one slot; the SPEC's bound is a
  record count, so a byte cap is not added (P7).
- **After a destination failure the controller keeps ticking** into a closed exporter (each tick counted as
  dropped) until its owner stops it; stopping the controller from the exporter would couple the two modules and
  was not approved. Flagged for `/pharn-grill`.
- **`CLAUDE.md` still describes a pnpm monorepo**; the live repo is a single npm package. Out of scope here,
  flagged for the human (as in `agent-samplers`).
