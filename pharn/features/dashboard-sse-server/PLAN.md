---
spec_id: dashboard-sse-server
spec_content_hash: dca6f9b42960a3e356d7c7a46890b97f0731c85ec4fcf2d8dbfd5e589c9e40b0
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `dashboard-sse-server` (ROADMAP S3, slice 1).

Discovery (live, this run): single npm package (`"type": "module"`, dual ESM/CJS via `scripts/build.mjs`),
`tsconfig.base.json` strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, `lib: ["ES2022"]`,
vitest `include: ['src/**/*.test.ts']`. `src/dashboard/index.ts` holds only the scaffold type `DashboardPlaceholder`
(used by `src/dashboard/index.test.ts`); the `./dashboard` export subpath already exists in `package.json`.
`src/collector/collector.ts` `createCollector({ windowMs, capacity, alerts?, sinks?, onSinkError? })` returns
`{ windows, alerts, sinks, consume(source), close() }`; `consume` runs `pipeline(source, aggregator, recordWindows,
evaluator, async final stage)`: `recordWindows` pushes each `AggregatedWindow` into the `windows` ring and the final
stage pushes each `Alert` into the `alerts` ring and calls `dispatcher.deliver(alert)`. Nothing exposes new windows
or alerts to an outside listener, so the collector needs one small subscription hook.

Design (each file one axis of change; Node core only; `src/dashboard` imports only `import type` from
`../collector/index.js`; nothing in `src/collector` or `src/agent` imports `src/dashboard`):

1. **Collector subscription hook** (`src/collector/collector-subscribers.ts`, new) — the collector's live-event
   fan-out, nothing else.
   - `CollectorListener = { window?(window: AggregatedWindow): void; alert?(alert: Alert): void }`.
   - `createSubscriberSet()` → `{ add(listener): () => void; emitWindow(window): void; emitAlert(alert): void }`.
     `add` stores the listener in a `Set` and returns an idempotent unsubscribe. `emit*` iterates a copy of the set
     and calls each listener inside `try/catch`; a throwing listener is reported through `process.emitWarning` (never
     silent) and can never fail the collector's pipeline or skip other listeners.
2. **Collector** (`src/collector/collector.ts`, modified, minimal).
   - `Collector` gains `subscribe(listener: CollectorListener): () => void`.
   - In `recordWindows`, after `windows.push(window)`, call `subscribers.emitWindow(window)`; in the final stage,
     after `alerts.push(alert)`, call `subscribers.emitAlert(alert)` (before `dispatcher.deliver`). With no
     subscriber this is an empty-set iteration, so existing collector behaviour (collector-windows, collector-alerts,
     collector-alert-sinks criteria) is unchanged.
3. **Collector entrypoint** (`src/collector/index.ts`, modified) — adds `export type { CollectorListener }`; every
   existing export is kept, including `CollectorPlaceholder`.
4. **Auth** (`src/dashboard/auth.ts`, new) — host classification and token comparison only.
   - `isLoopbackHost(host: string): boolean` — `true` for `localhost`, `::1` (also bracketed `[::1]`) and any IPv4
     literal in `127.0.0.0/8` (`net.isIPv4(host)` and first octet `127`); everything else, including `0.0.0.0` and
     `::`, is non-loopback.
   - `tokensMatch(presented: string, expected: string): boolean` — hashes both with `crypto.createHash('sha256')` and
     compares the two 32-byte digests with `crypto.timingSafeEqual`, so differing lengths never throw and never
     short-circuit on content.
   - `presentedToken(req: IncomingMessage, url: URL): string | undefined` — `Authorization: Bearer <token>` (scheme
     matched case-insensitively) first, else the `token` query parameter.
5. **SSE wire format** (`src/dashboard/sse-format.ts`, new) — `formatEvent(event: 'window' | 'alert', payload:
   unknown): string` → `` `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n` `` (JSON.stringify never emits a
   raw newline, so `data:` is always one line) and `HEARTBEAT = ':heartbeat\n\n'`.
6. **Per-client stream** (`src/dashboard/sse-client.ts`, new) — one SSE response with bounded pending output.
   - `createSseClient(res: ServerResponse, options: { maxBufferedEvents: number; onDrop(): void })` →
     `{ send(chunk: string): void; heartbeat(): void; readonly dropped: number; end(): void }`.
   - State: `blocked` flag and a pending queue (array plus head index, compacted when the head passes half the
     array). `send`: when not blocked, `const ok = res.write(chunk)`; `ok === false` sets `blocked` and waits for the
     response's `'drain'`, which flushes the queue in order until a write returns `false` again. When blocked, the
     chunk is queued; if the queue then exceeds `maxBufferedEvents`, the **oldest** pending chunk is discarded,
     `dropped += 1` (integer) and `onDrop()` is called. Memory per client is therefore bounded by
     `maxBufferedEvents` chunks plus Node's own writable buffer.
   - `heartbeat()` writes `HEARTBEAT` only when not blocked (a blocked client is skipped, never queued).
   - `end()` removes its `'drain'` listener, clears the queue and calls `res.end()`; idempotent.
7. **Server** (`src/dashboard/server.ts`, new) — `createDashboardServer(options: DashboardServerOptions):
   Promise<DashboardServer>`.
   - `DashboardServerOptions = { collector: Collector; host: string; port: number; token?: string; heartbeatMs?:
     number; maxBufferedEvents?: number; onError?: (error: Error) => void }`. Defaults: `heartbeatMs` 15000,
     `maxBufferedEvents` 1000; both validated as positive safe integers (`RangeError`); `port` a safe integer
     0–65535; `token`, when given, a non-empty string.
   - **Refuse before binding:** `!isLoopbackHost(host) && token === undefined` → reject with an `Error` whose message
     says a token is required for a non-loopback host. All validation runs before `http.createServer`/`listen`, so no
     port is ever bound on refusal.
   - `DashboardServer = { readonly host: string; readonly port: number; readonly url: string; readonly clientCount:
     number; readonly droppedEvents: number; close(): Promise<void> }`. `port` is read from `server.address()` after
     `listen` resolves (so port 0 works). `droppedEvents` is the integer total over all clients, past and present
     (incremented by each client's `onDrop`).
   - Listening: `server.listen(port, host)` wrapped in a promise that rejects on the `'error'` emitted before
     `'listening'`; after listening, a persistent `'error'` listener and a `'clientError'` listener (destroy the
     socket) report through `onError`.
   - **Request handling, in this order:** parse `new URL(req.url ?? '/', 'http://localhost')`. If a token is
     configured and `presentedToken` is missing or `!tokensMatch` → `401`, `content-type: text/plain`,
     `www-authenticate: Bearer`, body `unauthorized\n` — before any routing. Then: path `/events` with method
     `GET` → SSE; `/events` with another method → `405`; any other path → `404` (`text/plain`).
   - **SSE:** `writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache',
     'connection': 'keep-alive', 'x-accel-buffering': 'no' })` and `flushHeaders()`. Create the client, then in one
     synchronous block: take `collector.windows.snapshot()` and `collector.alerts.snapshot()`, call
     `collector.subscribe({ window: w => client.send(formatEvent('window', w)), alert: a =>
     client.send(formatEvent('alert', a)) })`, then send the window snapshot then the alert snapshot (each oldest
     first). No collector event can run between snapshot and subscribe, so nothing is missed or duplicated. Each
     payload is stringified once per client send; the send path never awaits, so the collector's pipeline is never
     blocked by a viewer.
   - **Heartbeat:** one server-wide `setInterval(heartbeatMs)` (`unref()`ed) calls `heartbeat()` on every client.
   - **Cleanup:** on `req`/`res` `'close'`: unsubscribe from the collector, `client.end()`, remove the client from the
     server's set. `req`, `res` and socket `'error'` events are reported through `onError` (default
     `process.emitWarning`, so nothing is swallowed), then the same cleanup runs. `onError` is called in
     `try/catch`; a throwing handler falls back to `process.emitWarning`.
   - **`close()`** (idempotent, returns the same promise): clear the heartbeat interval, end every client (unsubscribe
     + `res.end()`), call `server.close()` (promise-wrapped) and then `server.closeAllConnections()` so a stalled
     client whose socket never drains cannot hold `close()` open; resolves when the server has closed. A new
     connection to the port is then refused.
8. **Dashboard entrypoint** (`src/dashboard/index.ts`, modified) — exports `createDashboardServer`,
   `DashboardServer`, `DashboardServerOptions`; keeps `DashboardPlaceholder` so the scaffold test stays valid.

Constraints held by construction: Node core only (`node:http`, `node:crypto`, `node:net`); dashboard→collector is
`import type` only plus the runtime `collector` object passed in; no `.pipe()` anywhere; counters change only by
`+= 1`; every timer and listener is removed on disconnect or `close()`.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/collector/collector-subscribers.ts`; wire `subscribe` and the two `emit*` calls into
  `src/collector/collector.ts`; export `CollectorListener` from `src/collector/index.ts`.
- Add `src/dashboard/auth.ts`, `src/dashboard/sse-format.ts`, `src/dashboard/sse-client.ts` and
  `src/dashboard/server.ts`.
- Update `src/dashboard/index.ts` exports.
- Run `npx prettier --write` on every written file, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build` and `npm run check:exports`.

## Files

- `src/collector/collector-subscribers.ts` — new. `CollectorListener` type and `createSubscriberSet` (add /
  unsubscribe / emitWindow / emitAlert, listener errors reported via `process.emitWarning`).
- `src/collector/collector.ts` — modified. `Collector.subscribe(listener)`; emits each recorded window and alert to
  subscribers right after the ring push.
- `src/collector/index.ts` — modified. Re-exports the `CollectorListener` type.
- `src/dashboard/auth.ts` — new. `isLoopbackHost`, `tokensMatch` (sha256 + `timingSafeEqual`), `presentedToken`.
- `src/dashboard/sse-format.ts` — new. `formatEvent` and the heartbeat comment.
- `src/dashboard/sse-client.ts` — new. Per-client bounded queue, drop-oldest with integer `dropped`, drain handling,
  heartbeat, `end()`.
- `src/dashboard/server.ts` — new. `createDashboardServer`: option validation, token refusal before bind, auth
  before routing, `/events` SSE replay then live, heartbeat interval, cleanup, `close()`.
- `src/dashboard/index.ts` — modified. Exports `createDashboardServer`, `DashboardServer`,
  `DashboardServerOptions`; keeps `DashboardPlaceholder`.

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC.
- `src/collector/ring-buffer.ts`, `src/collector/window.ts`, `src/collector/window-aggregator.ts`,
  `src/collector/alert-evaluator.ts`, `src/collector/alert-rules.ts`, `src/collector/sink-dispatcher.ts` — reused
  as is.
- `src/dashboard/index.test.ts` and every existing `src/collector/*.test.ts` — existing tests; they must keep
  passing unchanged.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs`, `scripts/check-exports.mjs` — test and build infrastructure; the
  `./dashboard` export subpath already exists.

## Acceptance mapping

- **AC-1** (collector already holding one window and one alert; server on `127.0.0.1:0`, no token, short
  `heartbeatMs`; client `GET /events`; collector then produces one more window and alert): the handler writes 200
  with `text/event-stream`, replays the window snapshot then the alert snapshot as `event: window` / `event: alert`
  with one JSON `data:` line each; the subscription registered in the same synchronous block forwards the next
  window and alert from `recordWindows` and the final stage; the server interval writes `:heartbeat` lines.
- **AC-2** (`0.0.0.0` without token → creation rejects mentioning the token, nothing listening; `127.0.0.1:0` with
  token `s3cret` and five credential variants): the non-loopback check runs before `listen`; the auth check runs
  before routing, returns 401 with a plain-text body (no `event:` line) for missing / `Bearer wrong` /
  `?token=wrong`, and the SSE response for `Bearer s3cret` / `?token=s3cret`.
- **AC-3** (small `maxBufferedEvents`, one stalled client and one reading client, many windows; then `close()`): the
  reading client's sends never block and it receives every window; the collector rings are untouched by the
  dashboard so `windows.snapshot()` holds the newest; once the stalled socket's kernel and Node buffers fill,
  `res.write` returns `false`, its queue overflows and `droppedEvents` becomes a positive integer; `close()` ends
  every response, closes all connections and the server, so it resolves and a new connection is refused.

## Risks & open questions

- **Names are plan choices** (`createDashboardServer`, options `collector`, `host`, `port`, `token`, `heartbeatMs`,
  `maxBufferedEvents`, `onError`; server fields `host`, `port`, `url`, `clientCount`, `droppedEvents`, `close()`;
  `Collector.subscribe`; path `/events`). The AC tests drive exactly these.
- **AC-3 volume.** A stalled client only shows backpressure after the OS socket buffers (often hundreds of KB on
  loopback) and Node's writable buffer fill, so the test must produce enough windows (thousands, each about 300 bytes
  of JSON) or poll `droppedEvents` until positive with a timeout. The collector's `capacity` must be set so the
  `windows` snapshot assertion is about the newest windows.
- **Stalled client in tests** should be a raw `node:net` socket that sends the GET request and then `pause()`s; an
  HTTP client library would read its buffer.
- **Default error reporting** without `onError` is `process.emitWarning`; an ordinary client disconnect (ECONNRESET)
  may surface as a warning. Flagged for `/pharn-grill`.
- **Collector change** is one new method plus two emit calls; `subscribe` is the only public addition to
  `Collector`.
