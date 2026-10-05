---
trust: trusted
purpose: "Expected output for case-using-declaration (true-negative): the handle is acquired with a `using` (RAII) declaration, so the scanner reports it CLEAN; the lens emits NO finding."
---

# Expected — case-using-declaration (true-negative)

The lens runs `pharn/floor/scan-code-resource-leak.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The handle is bound with a `using` declaration (TC39 explicit resource
management), which auto-disposes at scope exit — the scanner classifies it CLEAN deterministically. The
lens must emit **no** finding.

## The expected output

- **Zero findings** (`finding_count == 0`). The lens notes in prose: "scanner clean; the handle is a
  `using` binding (auto-disposed) — no unclosed-resource shape detected." It does **not** manufacture a
  finding.

## Why this PASSES

- A `using` / `await using` declaration is recognized deterministically as RAII cleanup; the scanner
  skips it, proving the lens does not false-positive on explicit resource management.
- Honest bound (Layer 1): a clean scan is **not** proof the code is leak-free — it means no unclosed
  fixed-set binding was detected. Whether the runtime actually supports `Symbol.dispose` here is
  advisory, not a floor claim.

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a false positive on a `using`-managed resource. **FAIL.**

## Trust-class check (P2, fix #1)

- No finding is emitted, so there are no enum-gated or free-text finding fields to check; the prose note
  inherits the code's untrusted tag and is rendered as DATA.
