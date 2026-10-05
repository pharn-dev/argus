---
trust: trusted
purpose: "Expected output for case-corrected-bound. The loop uses the correct `< buf.length` operator, so the scanner is clean and the lens emits NO finding. Encodes the true-negative: the lens does not over-flag the correct `<` form."
---

# Expected — corrected-bound

The lens must emit **zero** findings.

## Why

- `pharn/floor/scan-code-off-by-one.mjs` reports `found:false`: the loop bound is `i < buf.length` (the
  correct `<` operator), which is **not** the `<= <expr>.length` shape the scanner detects.
- The lens therefore emits **no** finding and **does not manufacture** one. Per Layer 1's honest bound,
  a clean scan is **not** proof the code is boundary-safe — only that the `<= .length` shape is absent.

## Structural vs semantic split (eval-format.md — cited, not restated, P4)

`expected-corrected-bound.json` (`skill_kind: llm`):

- **`structural[]` (1, floor-reducible):** `finding_count == 0`.
- **`semantic[]` (1, advisory llm-judge):** the clean scan is because of the `<` operator, and the lens
  does not manufacture a finding — while a clean scan is not proof of boundary-safety.
