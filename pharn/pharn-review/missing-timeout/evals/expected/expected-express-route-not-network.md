---
trust: trusted
purpose: "Expected output for case-express-route-not-network: an Express route `app.get(...)` is not an HTTP-client call and is not matched — the over-match bound (no app.get/router.post false-positive)."
skill_kind: llm
---

# Expected — express-route-not-network

The lens must emit **no** finding. `pharn/floor/scan-code-missing-timeout.mjs` reports `found:false`
because `app.get('/users', …)` is an Express **route registration** — a bare verb on the `app`
receiver, not a client-side network call, and there is no remote request to time out. The scanner's
call set is anchored on library/receiver tokens (`fetch` / `axios` / `http`/`https` / a fixed
db-receiver allowlist), never a bare `.get` on an arbitrary receiver.

- `finding_count == 0` is the whole structural assertion (`expected-express-route-not-network.json`,
  `skill_kind: llm`).
- This is the **over-match bound**: it proves `app.get(...)` / `router.post(...)` are not mistaken for
  HTTP-client calls. The lens must not manufacture a finding here.
