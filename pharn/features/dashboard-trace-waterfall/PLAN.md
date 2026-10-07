---
spec_id: dashboard-trace-waterfall
spec_content_hash: "4c3d8ea4310c324116ae32048f7c6a110cba5ee9fe058ef8fcebd0e9967a1891"
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `dashboard-trace-waterfall` (ROADMAP S3, "Trace
> detail / waterfall view in the dashboard").

Discovery (live, this run):

- `src/dashboard/server.ts` already sends every span as an SSE `span` event. It replays
  `collector.spans.snapshot()` (oldest first) on each new connection, then streams live spans. The payload is the
  agent's `SpanRecord` (`src/agent/span-record.ts` + `src/agent/span-buffer.ts` `TraceSpan`): `type: 'span'`,
  `traceId`, `spanId`, `name`, `method`, `path`, `statusCode`, `startTimeMs` (epoch ms), `durationNs`.
- The page is `src/dashboard/ui/page.ts` `renderPage(tokenQuery)`, a static HTML document with four headed
  `<section>`s, no inline script or style, and one `<script src="app.js…" defer>`.
- The client is `src/dashboard/ui/app-script.ts` `APP_SCRIPT`, one classic script in a `String.raw` template. It
  holds no backtick and no `${`. Its `handleFrame` ignores every event except `window` and `alert`, so `span` events
  are dropped today.
- The stylesheet is `src/dashboard/ui/app-style.ts` `APP_STYLE`.
- `src/dashboard/static-assets.ts` serves `/`, `/app.css` and `/app.js`. `src/dashboard/security-headers.ts`
  holds `CONTENT_SECURITY_POLICY`; this feature does not change it.
- vitest runs `src/**/*.test.ts` in `environment: 'node'`. `happy-dom` is already a dev dependency. tsconfig is
  strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `lib: ["ES2022"]`, no DOM types).

### Decisions

1. **One source for the view-model, shared by the unit test and the served script.** The waterfall layout is one
   pure, DOM-free TypeScript function, `buildWaterfall`, in its own module `src/dashboard/ui/waterfall-model.ts`.
   Unit tests import it directly. `APP_SCRIPT` embeds the same function's compiled text by concatenation:
   `String.raw\`…\` + buildWaterfall.toString() + String.raw\`…\``. tsc (both the ESM and the CJS build) and the
   vitest transform strip the types, so `toString()` yields plain JavaScript.

   This rules out a hand-copied second implementation in the classic script, which would drift. To keep
   `toString()` valid on its own, the function must be **self-contained**:
   - one `function buildWaterfall(spans, maxTraces) { … }` declaration;
   - every helper declared inside its body, with no reference to any module-level binding, import or constant;
   - no `${` and no backtick in its body, so the surrounding script stays template-safe and the concatenation
     stays plain text.
2. **Signature.** `export function buildWaterfall(spans: readonly unknown[], maxTraces: number): WaterfallModel`.
   - The input is `unknown[]` because SSE payloads are untrusted data. A span is used only when `traceId` and
     `spanId`, `method` and `path` are strings, `statusCode`, `startTimeMs` and `durationNs` are finite numbers,
     and `durationNs >= 0`. Any other entry is skipped, not thrown on.
   - A duplicate `spanId` within one trace keeps the last copy, so the server's replay plus a live copy never shows
     twice.
   - `maxTraces` must be a positive integer; any other value throws a `RangeError` (explicit, never silent).
   - Exported types: `WaterfallRow`, `WaterfallTrace` and `WaterfallModel`.
3. **Grouping and the N most recent traces (AC-2).**
   - Spans are grouped by `traceId`. A trace's start is the minimum `startTimeMs` of its spans.
   - Traces are sorted by start, newest first. Ties break on `traceId` so the order is deterministic.
   - The model keeps the first `maxTraces` traces and drops the rest.
   - Rows within a trace are sorted by `startTimeMs` ascending, then `spanId`.
4. **Visible range and geometry (AC-1, SPEC Assumption).**
   - The visible range runs from `rangeStartMs` (the earliest start among the **kept** traces' spans) to
     `rangeEndMs` (the latest `startTimeMs + durationNs / 1e6` among them).
   - Each row carries `offsetPct = (startTimeMs - rangeStartMs) / rangeMs * 100` and
     `widthPct = (durationNs / 1e6) / rangeMs * 100`, both in percent of the range.
   - When `rangeMs` is `0` (no spans, or one zero-length span), both are `0`. The stylesheet gives the bar a minimum
     width so it stays visible.
   - These are display-only floats. No counter is computed in floating point, which keeps CLAUDE.md's integer-math
     rule for aggregation intact.
5. **Row fields.** Each row carries `traceId`, `spanId`, `method`, `path`, `statusCode`, `durationNs`, `startTimeMs`,
   `offsetPct`, `widthPct`, `isError` and `label`.
   - `isError` is `statusCode >= 500 && statusCode <= 599`. Status 0 is not an error (SPEC Assumption).
   - `label` is `method + ' ' + path + ' ' + statusCode + ' ' + (durationNs / 1e6).toFixed(1) + ' ms'`, for example
     `GET /users 503 12.5 ms`. This is the same ms format as the dashboard's existing `formatMs`.
   - The model is `{ rangeStartMs, rangeEndMs, traces: [{ traceId, startTimeMs, rows: [...] }] }`.
6. **N.** `MAX_TRACES = 20` is a fixed constant inside `APP_SCRIPT` (SPEC Assumption: not a user setting).
7. **Bounded memory in the page.**
   - The client keeps one `spans` array. On each `span` event it pushes the parsed payload and calls
     `buildWaterfall(spans, MAX_TRACES)`. It then **replaces** `spans` with only the rows of the kept traces, so the
     store never holds spans of dropped traces.
   - A per-store cap `MAX_SPANS = 500` drops the oldest spans beyond it, so one trace with endless spans cannot grow
     the store either.
   - On each new SSE connection the client clears the store and the rendered rows, the same way it clears alerts
     today, because the server replays its span snapshot on every connection.
8. **Rendering under the unchanged CSP.**
   - The page gains a fifth section: `<section aria-labelledby="waterfall-heading">` with
     `<h2 id="waterfall-heading">Recent requests</h2>`, `<ol id="waterfall" aria-label="Trace waterfall"></ol>` and
     `<p id="waterfall-empty">No requests yet</p>`. The markup has no `style=` and no `on*=`.
   - `renderWaterfall(model)` rebuilds `#waterfall` with `document.createElement` + `textContent` only, never
     `innerHTML`, so a path can never inject markup. Each trace is one `<li class="trace">` holding its rows. A row is
     a label element plus a track element containing a bar element. The bar gets `bar.style.left = offsetPct + '%'`
     and `bar.style.width = widthPct + '%'`.
   - Setting styles through the CSSOM is not an inline `style` attribute, and CSP `style-src 'self'` does not block
     it. The CSP string stays byte-identical, and `security-headers.ts` is not touched.
   - Error rows get the class `row-error` and the text marker `error` in the label element, so the error state is
     visible without colour.
   - `#waterfall-empty` is hidden while any trace is shown.
9. **Event handling.**
   - `handleFrame` accepts `span` alongside `window` and `alert`.
   - A `JSON.parse` failure or a `RangeError` goes through the existing catch, which logs with `console.error` and
     shows it in the status. Nothing fails silently.
   - `init()`'s missing-element check adds `#waterfall` and `#waterfall-empty`.

### Modules (one axis of change each; only `src/dashboard/ui/` changes)

1. **`src/dashboard/ui/waterfall-model.ts` (new)**: the pure layout function and its types. It has no DOM, no
   import and no module-level state.
2. **`src/dashboard/ui/app-script.ts` (modified)**: imports `buildWaterfall` and embeds `buildWaterfall.toString()`
   in the IIFE by concatenation. It adds `MAX_TRACES`/`MAX_SPANS`, the span store, `renderWaterfall`, `clearWaterfall`,
   the `span` branch in `handleFrame`, and the clear on connect.
3. **`src/dashboard/ui/page.ts` (modified)**: adds the "Recent requests" section (Decision 8).
4. **`src/dashboard/ui/app-style.ts` (modified)**: adds styles for the waterfall:
   - the `.trace` and row layout, with the label and the track side by side;
   - `.track` as `position: relative`, and `.bar` as `position: absolute` with `min-width: 2px`;
   - `.row-error`, using the existing `--error` variable;
   - no `@import` and no `url(…)`.

The server, the static route table, the security headers, the agent and the collector are unchanged.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/dashboard/ui/waterfall-model.ts` with the self-contained `buildWaterfall` and its exported types.
- Modify `src/dashboard/ui/app-script.ts`:
  - concatenate the function text into the IIFE;
  - add the span store, `renderWaterfall` and `clearWaterfall`, and the `span` event branch;
  - clear the waterfall on each new connection.
- Add the "Recent requests" section to `src/dashboard/ui/page.ts` and the waterfall styles to
  `src/dashboard/ui/app-style.ts`.
- Run `npx prettier --write` on each of the four written files by name.
- Run `npm run typecheck`, `npm run lint`, `npm test` (including the existing `dashboard-ui` and
  `span-export-wiring` tests), `npm run build`, `npm run check:exports` and `npm run format:check`.
- Confirm that `dist/esm/dashboard/ui/app-script.js` and `dist/cjs/dashboard/ui/app-script.js` both produce a script
  containing `function buildWaterfall`. For example, import each build's `APP_SCRIPT` and check that
  `new Function(APP_SCRIPT)` parses.

## Files

- `src/dashboard/ui/waterfall-model.ts`: new. `buildWaterfall(spans, maxTraces)` plus the `WaterfallRow`,
  `WaterfallTrace` and `WaterfallModel` types. Pure, DOM-free and self-contained, so its `toString()` is valid
  standalone JavaScript.
- `src/dashboard/ui/app-script.ts`: modified. Embeds `buildWaterfall.toString()` and handles the `span` SSE event:
  a bounded span store (`MAX_TRACES = 20`, `MAX_SPANS = 500`), `renderWaterfall` using createElement, textContent
  and CSSOM bar geometry, and a clear on reconnect.
- `src/dashboard/ui/page.ts`: modified. Adds the "Recent requests" section with `#waterfall` (`aria-label="Trace
  waterfall"`) and `#waterfall-empty`.
- `src/dashboard/ui/app-style.ts`: modified. Adds the waterfall row, track, bar and error styles.

### Explicitly not touched

- `src/dashboard/security-headers.ts`: the CSP stays byte-identical (SPEC Constraint).
- `src/dashboard/server.ts` and `src/dashboard/static-assets.ts`: they already serve `/app.js` and stream `span`
  events.
- `src/agent/**` and `src/collector/**`: out of scope per the SPEC; the `span` event shape is unchanged.
- `package.json`, `package-lock.json`, `vitest.config.mts`: no new dependency and no test-infra change.

## Acceptance mapping

- **AC-1** → `buildWaterfall` (Decisions 2–5) groups rows by trace id with one row per span. Each row carries
  `offsetPct` and `widthPct` proportional to its start and duration within the earliest-start to latest-end range,
  and a `label` containing the method, path, status and duration. `isError` is true for 503 and false for 200.
  Unit test: `src/dashboard/dashboard-trace-waterfall.ac1.test.ts`.
- **AC-2** → `buildWaterfall` keeps exactly the `maxTraces` most recently started traces (Decision 3). Unit test:
  `src/dashboard/dashboard-trace-waterfall.ac2.test.ts`.
- **AC-3** → the page gains a list named "Trace waterfall" under the heading "Recent requests", and the markup still
  has no inline script or style (Decision 8). The served `app.js` handles `event: span` (Decision 9). The CSP header
  is unchanged because `security-headers.ts` is untouched. Integration test:
  `src/dashboard/dashboard-trace-waterfall.ac3.integration.test.ts`.

## Risks & open questions

- **`Function.prototype.toString()` as the sharing mechanism.** It depends on the emitted function being
  self-contained. Three things would break that:
  - a reference to a module-level binding;
  - a transform that injects helpers (for example a downlevel target), which ES2022 does not need;
  - coverage instrumentation that rewrites the source. vitest's default v8 coverage does not rewrite it, but
    istanbul would.

  The build stage should keep the function free of outside references. The existing `dashboard-ui` AC-3 test runs
  the served `APP_SCRIPT` in happy-dom, so a broken embedding fails that regression test.
- **CSSOM style vs. CSP.** Per the CSP spec, `element.style.x = …` is not blocked by `style-src` without
  `'unsafe-inline'`, but `setAttribute('style', …)` is. The build must use the CSSOM property form. No e2e criterion
  checks real-browser rendering (SPEC Assumption).
- **Multi-span traces.** The agent emits one HTTP server span per request today, so most traces have one row.
  Grouping is still implemented and tested with spans that share a `traceId`.
- **Memory bound.** The bound is advisory: `MAX_TRACES` plus `MAX_SPANS` in the client. AC-2 tests it only through
  the view-model. The store pruning in the page is not covered by an AC test.
