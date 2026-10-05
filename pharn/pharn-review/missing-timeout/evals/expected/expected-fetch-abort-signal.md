---
trust: trusted
purpose: "Expected output for case-fetch-abort-signal: a fetch guarded by an AbortSignal timeout via the `signal` option reads CLEAN — the precision bound proving the scan is not naive 'every fetch is flagged'."
skill_kind: llm
---

# Expected — fetch-abort-signal

The lens must emit **no** finding. `pharn/floor/scan-code-missing-timeout.mjs` reports `found:false`
because the call binds an `AbortSignal` timeout via the `signal` option — a recognized in-args timeout
mechanism (`signal`, and the nested timeout, are both indicator tokens).

- `finding_count == 0` is the whole structural assertion (`expected-fetch-abort-signal.json`,
  `skill_kind: llm`).
- This is the **precision bound**: it proves the scanner respects the idiomatic `fetch` timeout
  mechanism (an `AbortSignal`) rather than flagging every `fetch`. The lens must not manufacture a
  finding here.
