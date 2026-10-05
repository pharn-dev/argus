---
trust: trusted
purpose: "Expected output for case-length-minus-one. A `<=` appears but its right operand is `buf.length - 1` (arithmetically corrected), not a bare `.length`, so the scanner is clean and the lens emits NO finding. Encodes the PRECISION bound: the scanner is not a naive `<= *.length` match."
---

# Expected — length-minus-one

The lens must emit **zero** findings.

## Why

- `pharn/floor/scan-code-off-by-one.mjs` reports `found:false`: although a `<=` is present, its right
  operand is `buf.length - 1`, not a **bare** `.length` — the `- 1` correction is respected, so the
  scanner does not fire. This is the precision bound proving the scanner is not a naive `<= *.length`
  match.
- The lens therefore emits **no** finding and **does not manufacture** one. A clean scan is **not**
  proof the code is boundary-safe — only that the bare-`.length` `<=` shape is absent.

## Structural vs semantic split (eval-format.md — cited, not restated, P4)

`expected-length-minus-one.json` (`skill_kind: llm`):

- **`structural[]` (1, floor-reducible):** `finding_count == 0`.
- **`semantic[]` (1, advisory llm-judge):** the clean scan is because of the `- 1` correction, and the
  lens does not manufacture a finding — while a clean scan is not proof of boundary-safety.
