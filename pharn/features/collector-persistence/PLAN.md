---
spec_id: collector-persistence
spec_content_hash: aef97b4dab00e2f56a841bb6563e872e960151d45a44755be5f2dfc4d71914a0
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `collector-persistence` (ROADMAP S2, final slice).

Discovery (live, this run): single npm package (`"type": "module"`, dual ESM/CJS), strict TypeScript, vitest
`include: ['src/**/*.test.ts']`. `src/collector/collector.ts` exports `createCollector({ windowMs, capacity, alerts?,
sinks?, onSinkError? })` → `{ windows, alerts, sinks, consume(source), close() }`. `consume` runs
`pipeline(source, aggregator, recordWindows, evaluator, async sink)` from `node:stream/promises`, where
`recordWindows` is an object-mode Transform that pushes each closed window into the `windows` ring
(`createRingBuffer(capacity)`, `push` / `snapshot` / `size`). `AggregatedWindow` (`src/collector/window.ts`) is a
plain object of integer fields. `file-sink.ts` already shows the append-mode pattern (`fs/promises` `open(path, 'a')`
+ `appendFile`). There is no persistence code yet.

Design (each file one axis of change; Node core only):

1. **Window line codec** (`src/collector/window-codec.ts`, new) — the NDJSON format only, no I/O.
   - `serializeWindow(window: AggregatedWindow): string` → `JSON.stringify(window) + '\n'`.
   - `parseWindowLine(line: string): AggregatedWindow | undefined` → `JSON.parse` inside `try/catch`; returns a
     freshly built `AggregatedWindow` (exactly the known fields, so no extra or prototype keys leak in) only when
     every field — `start`, `end`, `count`, `late`, `eventLoop.{max,p99,mean}`,
     `memory.{heapUsedLast,heapUsedMax,rssLast,rssMax}`, `gc.{count,totalPause,maxPause}`,
     `backpressure.{events,totalStall,maxStall}` — is `Number.isSafeInteger`; otherwise `undefined`.
2. **Window store** (`src/collector/window-store.ts`, new) — the append-only file, restore and compaction.
   - `PersistOptions = { path: string; maxBytes: number }`.
   - `createWindowStore(options: PersistOptions & { capacity: number }): WindowStore`, validating synchronously:
     `path` not a non-empty string → `TypeError('persist.path must be a non-empty string')`; `maxBytes` not a
     positive safe integer (covers 0, -1, non-integers and non-numbers) → `RangeError('persist.maxBytes must be a
     positive safe integer')`. No I/O at construction.
   - `WindowStore = { readonly path; readonly maxBytes; readonly skipped: number; readonly restored: number;
     readonly bytes: number; restore(): Promise<AggregatedWindow[]>; append(window): Promise<void>;
     release(): Promise<void> }`. `skipped`, `restored` and `bytes` are integer getters.
   - `restore()`: `readFile(path)`; `ENOENT` → nothing to restore (no file is created by the read). Any other error
     rejects. The content is split on `'\n'`; a final empty element (the text after the last newline) is ignored;
     every other line goes through `parseWindowLine`, valid windows are pushed into a store-internal
     `createRingBuffer(capacity)` (so only the last `capacity` survive), invalid ones do `skipped += 1`. `bytes` is set
     to the byte length read. If the file is non-empty and does not end in `'\n'` (a partial last line left by a
     crash), a `needsNewline` flag is set so the first append writes a leading `'\n'`, and the partial line can never
     merge with a new window. Returns the ring snapshot (oldest first); `restored` is its length.
   - `append(window)`: serialized on a promise chain; lazily `open(path, 'a')` (append mode; creates the file but
     never its parent directory), `handle.appendFile(line)`, `bytes += Buffer.byteLength(line)` (integer), push the
     window into the store ring, then, if `bytes > maxBytes`, `compact()`. Any error rejects the returned promise.
   - `compact()`: close the append handle, write the ring snapshot (the last `capacity` windows) to
     `${path}.compact.tmp` (`open(tmp, 'w')`, `writeFile`, `datasync`, `close`), then `rename(tmp, path)` — the
     previous file stays intact until the rename replaces it. `bytes` becomes the temp file's byte length; the next
     append reopens in `'a'`. On failure, best-effort `rm(tmp, { force: true })` and reject with the original error
     (an `rm` failure is attached as the error's `cause` chain, never dropped silently).
   - `release()`: awaits the chain and closes the append handle (if any). Called at the end of every `consume` and
     by `collector.close()`, so no handle outlives a consume.
3. **Collector** (`src/collector/collector.ts`, modified).
   - `CollectorOptions` gains `persist?: PersistOptions`. When absent, nothing below runs and no file is created,
     opened or read: behaviour is identical to today.
   - `createCollector` builds `createWindowStore({ ...options.persist, capacity })` after the existing validation, so
     a bad `path` / `maxBytes` throws synchronously from creation. `createCollector` stays synchronous.
   - `Collector` gains `readonly persistence: WindowPersistence | undefined`, where `WindowPersistence = { readonly
     path: string; readonly maxBytes: number; readonly skipped: number; readonly restored: number; readonly bytes:
     number }` (live getters over the store; `undefined` without the option).
   - Restore happens at the start of the **first** `consume` (memoized promise), before the pipeline starts, so the
     restored windows enter the `windows` ring before any new window. Restored windows go to the ring only: they
     are not evaluated against alert rules and not delivered to sinks. A restore failure rejects `consume`.
   - A new object-mode Transform `persistWindows`, placed right after `recordWindows`, awaits `store.append(window)`
     before calling `callback(null, window)`. That await is the write backpressure: the pipeline pulls no further
     window until the line is on disk. An append error goes to `callback(error)`, so `pipeline()` — and therefore
     `consume` — rejects with it. Errors are never swallowed (no error callback is added; the SPEC allows either).
   - `consume`'s existing `finally` additionally awaits `store.release()`; a release error is surfaced (rejects
     `consume` when the pipeline itself succeeded; attached as `cause` otherwise). `close()` also releases the
     store after closing sinks.
4. **Entrypoint** (`src/collector/index.ts`, modified) — adds `createWindowStore`, `serializeWindow`,
   `parseWindowLine` and the types `PersistOptions`, `WindowStore`, `WindowPersistence`; keeps every existing export.

Constraints held by construction: Node core only (`node:fs/promises`, `node:stream`, `node:stream/promises`); the
only stream composition stays the existing `pipeline()` with one extra stage, no `.pipe()`; `skipped`, `restored` and
`bytes` change only by integer `+=` / assignment from `Buffer.byteLength` / `.length`; `src/agent`, the window
aggregator, the alert evaluator and the sinks are not changed.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/collector/window-codec.ts` (`serializeWindow`, `parseWindowLine`).
- Add `src/collector/window-store.ts` (`PersistOptions`, `WindowStore`, `createWindowStore` with restore, append,
  compaction, release).
- Extend `src/collector/collector.ts` with the `persist` option, `collector.persistence`, the first-consume restore,
  the `persistWindows` pipeline stage and the release in `finally` / `close()`.
- Update `src/collector/index.ts` exports.
- Run prettier on the written files, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and
  `npm run check:exports`.

## Files

- `src/collector/window-codec.ts` — new. NDJSON line serialization and strict parsing/validation of one
  `AggregatedWindow`.
- `src/collector/window-store.ts` — new. `createWindowStore`: option validation, restore with an integer `skipped`
  counter, append-mode writes, size-bounded compaction via temp file + rename, handle release.
- `src/collector/collector.ts` — modified. `persist` option, `collector.persistence`, restore before the first new
  window, `persistWindows` stage awaiting each append, store release.
- `src/collector/index.ts` — modified. Re-exports the store, the codec and the persistence types.

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC.
- `src/collector/window.ts`, `src/collector/window-aggregator.ts`, `src/collector/ring-buffer.ts`,
  `src/collector/alert-evaluator.ts`, `src/collector/alert-rules.ts` — reused as is.
- `src/collector/alert-sink.ts`, `src/collector/stdout-sink.ts`, `src/collector/file-sink.ts`,
  `src/collector/webhook-sink.ts`, `src/collector/sink-config.ts`, `src/collector/sink-dispatcher.ts` — the sinks
  are out of scope per the SPEC.
- Existing tests under `src/collector/` (collector-windows, collector-alerts, collector-alert-sinks, index) — they
  must keep passing unchanged.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure.

## Acceptance mapping

- **AC-1** (windowMs 1000, capacity 10, `persist` to a file in a temp dir vs. no `persist`; a source spanning three
  windows): restore finds no file (`ENOENT`, nothing created by the read); each of the three closed windows passes
  `recordWindows` then `persistWindows`, which appends one `serializeWindow` line in order, so the file's lines
  parse to exactly `collector.windows.snapshot()`. The second collector has no store, so the temp dir stays empty.
- **AC-2** (12 valid lines, one invalid line between them, a truncated last line; capacity 10; two new windows):
  restore counts the invalid line and the partial last line → `collector.persistence.skipped === 2`; the
  store ring keeps the last 10 of 12 valid windows, which go into `collector.windows` before the pipeline starts;
  the two new windows then push out the two oldest, leaving the last 8 restored followed by the 2 new. The first
  append writes a leading newline, so the new lines stay parseable.
- **AC-3** (capacity 3, small `maxBytes`): once `bytes > maxBytes`, compaction rewrites the file to the last 3
  windows through `${path}.compact.tmp` + `rename`, so every line parses, the lines are a contiguous in-order run
  ending at the last closed window, there are fewer lines than windows consumed, and the temp file is gone. With
  `path` pointing at a directory, restore's `readFile` (or the append's `open`) fails with `EISDIR` and `consume`
  rejects with that error. `maxBytes` 0 / -1 → synchronous `RangeError` naming `maxBytes`; `path: ''` → synchronous
  `TypeError` naming `path`.

## Risks & open questions

- **Names are plan choices** (`CollectorOptions.persist`, `PersistOptions.{path,maxBytes}`, `Collector.persistence`,
  `WindowPersistence.{skipped,restored,bytes}`, `createWindowStore`, `serializeWindow`, `parseWindowLine`, temp file
  `<path>.compact.tmp`). The AC tests drive `createCollector`, `persist` and `persistence.skipped`.
- **Error surface choice:** write errors reject `consume` (no error callback). The SPEC allows either.
- **Restore timing:** at the start of the first `consume`, not at construction, so `createCollector` stays
  synchronous and does no I/O; `collector.windows` holds no restored windows until `consume` is called. A failed
  restore is memoized, so every later `consume` on that collector rejects with the same error.
- **Restore reads the whole file** with `readFile`. Compaction keeps it near `maxBytes`, but a large pre-existing
  file is read into memory once; only `capacity` windows are retained.
- **Durability:** appends are not `fsync`ed per window (only the compaction temp file is), so a power loss can
  lose the last lines; a crash leaving a partial line is handled by the skip + leading-newline repair.
- **Two collectors on one file** are out of scope per the SPEC; nothing locks the file.
