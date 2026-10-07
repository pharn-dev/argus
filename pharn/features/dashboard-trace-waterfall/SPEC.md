---
spec_id: dashboard-trace-waterfall
state: Approved
spec_content_hash: "4c3d8ea4310c324116ae32048f7c6a110cba5ee9fe058ef8fcebd0e9967a1891"
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Someone debugging a slow or failing Node.js service at 2am opens the Argus dashboard and can see live
metrics, but not what individual requests did. The agent already streams HTTP spans to the dashboard as
`span` SSE events; nothing shows them. The user wants the dashboard page to show recent requests as a
trace waterfall (ROADMAP S3 "Trace detail / waterfall view in the dashboard"; FEATURES "Trace detail /
waterfall view per request"): one row per span, grouped by trace, with a bar whose position and length show
when the request started and how long it took within the visible time range, labelled with method, path,
status and duration, and with failed (5xx) requests marked as errors, so slow and failing requests stand out
at a glance. The page must stay small and safe to leave open: its memory stays flat however long it runs.

## Scope

**In scope:**

- Showing spans received as `span` SSE events on the dashboard page as a waterfall, one row per span,
  grouped by trace id.
- A bar per row whose offset and width are proportional to the span's start time and duration within the
  visible time range (from the earliest start to the latest end among the shown spans).
- A row label with HTTP method, path, status code and duration; rows with a 5xx status marked as errors.
- Keeping only the most recent N traces on the page, so the page's memory stays bounded.
- Computing the waterfall layout in a pure, DOM-free view-model function that can be unit-tested.

**Out of scope (non-goals):**

- Any change to the agent, the collector, or the shape of `span` SSE events.
- Child or nested spans, span parent links, or anything beyond the HTTP server spans the agent emits today.
- Persisting traces, searching or filtering them, or a separate trace-detail page or route.
- Any UI framework, bundler, inline script or inline style, or change to the dashboard's Content Security
  Policy.

## Acceptance Criteria

- **AC-1** Given spans from two traces with known start times (epoch ms) and durations (ns), one of them with
  status 503 and one with status 200
  When the waterfall view-model function is called with those spans
  Then it returns rows grouped by trace id, one row per span, where each row's offset and width (as a
  fraction or percent of the visible range from the earliest start to the latest end) equal the span's
  start and duration proportionally, each row carries a label containing its method, path, status code and
  duration, the 503 row is flagged as an error and the 200 row is not
  - verify: unit
- **AC-2** Given a maximum trace count N and spans from more than N distinct traces arriving in order
  When the waterfall view-model function is called with them
  Then the returned value contains exactly the N most recently started traces and none of the older ones
  - verify: unit
- **AC-3** Given a running dashboard server bound to localhost
  When the dashboard page and its script and style assets are fetched over HTTP
  Then the page responds 200 with an element named as the trace waterfall (an accessible name containing
  "waterfall" or "Recent requests"), the page contains no inline script or style, the
  Content-Security-Policy header is identical to what the server sent before this feature, and the
  served script handles the `span` event
  - verify: integration

## Constraints

- Vanilla JS only in the dashboard; no framework, no bundler, no new runtime dependency.
- No inline scripts or styles; the existing Content-Security-Policy stays unchanged.
- The page keeps a bounded number of traces (most recent N), so its memory stays flat over time.
- TypeScript strict mode; all files pass the repo's format, lint and typecheck gates.

## Assumptions

- The visible time range is the span from the earliest start to the latest end among the traces currently
  kept; offsets and widths are relative to it.
- N (the maximum number of kept traces) is a fixed default chosen by the plan, not a user setting.
- An error row is any span with status code 500 to 599; status 0 (no status recorded) is not an error.
- The view-model function is exposed so a unit test can import it; whether the served classic script reuses
  the same source text is a PLAN decision.
- "CSP unchanged" is checked as equality with the header the current server emits for the page.
- The project's `test` script (`vitest run`) is the runner PHARN finds; the test stage's preflight confirms it
  can run unit and integration criteria.
- Rendering in a real browser (pixel layout, scrolling) is not checked: the quick SPEC has no e2e criterion,
  so the bar geometry is verified only through the view-model's returned values.
