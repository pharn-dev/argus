---
trust: trusted
purpose: "Expected output for case-proper-handling (true-negative): the catch logs AND rethrows a wrapped error, so the scanner stays CLEAN; the lens emits NO finding."
---

# Expected — case-proper-handling (true-negative)

The lens runs `pharn/floor/scan-code-swallowed-exception.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The catch logs **and** `throw`s a wrapped `SyncError` — the `throw` HANDLE-token keeps
the classification CLEAN. The lens must emit **no** finding.

## The expected output

- **Zero findings** (`finding_count == 0`). The lens notes in prose: "scanner clean; the catch propagates via a
  rethrow — no empty/log-only swallow detected." It does **not** manufacture a finding.

## Why this PASSES

- The `throw new SyncError(...)` is a HANDLE token; the scanner's discriminator classifies the catch as CLEAN
  deterministically, proving the lens does not false-positive on proper error handling.
- Honest bound (Layer 1): a clean scan is **not** proof the code is error-safe — it means no empty/log-only catch
  **shape** was detected. Whether the wrapping/propagation is adequate is advisory, not a floor claim.

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a false positive on a properly-handled catch. **FAIL.**

## Trust-class check (P2, fix #1)

- No finding is emitted, so there are no enum-gated or free-text finding fields to check; the prose note inherits the
  code's untrusted tag and is rendered as DATA.
