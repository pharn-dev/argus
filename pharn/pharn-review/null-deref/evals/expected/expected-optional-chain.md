---
trust: trusted
purpose: "Expected output for case-optional-chain: the value is read via optional chaining (u?.email), so the scanner reports found:false and the lens emits NO finding."
---

# Expected — case-optional-chain (true-negative)

The lens runs `pharn/floor/scan-code-null-deref.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The first subsequent use of `u` is `u?.email` (optional chaining), which
the scanner recognizes as the null-safe form. The lens must emit **no** finding.

## Expected

- **No finding.** `finding_count == 0`.
- The lens notes in prose "scanner clean; no unchecked deref detected" — and does **not** manufacture a
  finding.

## Why this PASSES

- Optional chaining `u?.email` is null-safe; the scanner's first-occurrence classifier sees the `?.`
  and returns CLEAN — deterministically, not by judgment.
- A clean scan is **not** proof of null-safety — only that no unchecked-deref **shape** was detected.

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a false positive on null-safe optional-chained code. **FAIL.**

## Trust-class check (P2, fix #1)

- No finding is emitted, so no field carries taint; the empty array `[]` vacuously honors the split.
