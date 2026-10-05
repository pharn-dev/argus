---
trust: trusted
purpose: "Expected output for case-try-finally-close (true-negative): the write stream is closed on its binding in a finally, so the scanner stays CLEAN; the lens emits NO finding."
---

# Expected — case-try-finally-close (true-negative)

The lens runs `pharn/floor/scan-code-resource-leak.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The write stream is closed on its binding (`handle.close()`) inside the
`finally` — a cleanup call on the binding keeps the classification CLEAN. The lens must emit **no**
finding.

## The expected output

- **Zero findings** (`finding_count == 0`). The lens notes in prose: "scanner clean; the handle is
  closed on its binding in the finally — no unclosed-resource shape detected." It does **not**
  manufacture a finding.

## Why this PASSES

- `handle.close()` is a cleanup call on the binding; the scanner's discriminator classifies it CLEAN
  deterministically, proving the lens does not false-positive on a properly-closed resource.
- Honest bound (Layer 1): a clean scan is **not** proof the code is leak-free — a bare `finally`
  carries no weight; only a detected cleanup call on the binding does. Whether disposal is adequate on
  every path is advisory, not a floor claim.

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a false positive on a properly-closed resource. **FAIL.**

## Trust-class check (P2, fix #1)

- No finding is emitted, so there are no enum-gated or free-text finding fields to check; the prose note
  inherits the code's untrusted tag and is rendered as DATA.
