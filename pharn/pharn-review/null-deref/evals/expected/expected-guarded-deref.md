---
trust: trusted
purpose: "Expected output for case-guarded-deref: the value is guarded (if (!u) return) before the deref, so the scanner reports found:false and the lens emits NO finding."
---

# Expected — case-guarded-deref (true-negative)

The lens runs `pharn/floor/scan-code-null-deref.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The first subsequent use of `u` is the guard `if (!u) return null;`, so
the scanner classifies it CLEAN. The lens must emit **no** finding.

## Expected

- **No finding.** `finding_count == 0`.
- The lens notes in prose "scanner clean; no unchecked deref detected" — and does **not** manufacture a
  finding.

## Why this PASSES

- The guard `if (!u) return null;` is the first re-use of `u`, so the scanner's deterministic
  first-occurrence classification is CLEAN (not a raw deref).
- A clean scan is **not** proof the code is null-safe (Layer-1 bound: custom sources, optional params,
  non-JS/TS syntax, and data-flow-level nulls evade it) — only that no unchecked-deref **shape** was
  detected.

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a false positive on guarded code. **FAIL.**

## Trust-class check (P2, fix #1)

- No finding is emitted, so no field carries taint. A clean scan over untrusted input yields the empty
  array `[]` — the enum-gated / free-text split is vacuously honored.
