---
trust: trusted
purpose: "Expected output for case-allowed-and-empty: ZERO findings. Every comparison operand is an allow-set number (0, -1, 100, 1000) or an empty string, so the scanner reports found:false and the lens emits nothing — and does not manufacture a finding. Proves the wider allow-set {0,1,-1,2,10,100,1000} and the empty-string exclusion."
---

# Expected — allowed-and-empty

The lens must emit **no** finding (the empty array `[]`).

## Why this PASSES — a clean scan, no manufactured finding

- `pharn/floor/scan-code-magic-values.mjs` reports `found:false`: every comparison operand is in the
  numeric allow-set `{0, 1, -1, 2, 10, 100, 1000}` (`items.length === 0`, `idx === -1`, `batch <= 100`,
  `batch === 1000`) or is an empty string (`name === ""`, an emptiness check — not a magic value).
- The returned strings (`"empty"`, `"missing"`, `"small"`, `"full"`, `"anonymous"`, `"other"`) are **not
  comparison operands** (they follow `return`, not an equality operator), so they are out of scope and
  correctly not flagged.
- The lens emits **no** finding and does **not** invent one — a lens never manufactures a hit on a clean
  scan.

## Not a proof of constant-cleanliness (the honest bound)

A clean scan is **not** proof the file has no magic values — only that no **in-scope** magic-literal
comparison shape was detected. The Yoda form (`404 === x`), non-decimal numbers (hex/exponent/…),
magic numbers in arithmetic/indices/call-args, and multi-line comparisons all evade the v0.1.0 scanner
(Layer-1 bound). Absence of a finding here means "no in-scope shape," never "constant-clean."

## Structural (eval-format.md — cited, P4)

`expected-allowed-and-empty.json` (`skill_kind: llm`): **`structural[]` (1):** `finding_count == 0`.
**`semantic[]` (1, advisory):** the allow-set / empty-string operands justify `found:false` and the lens
emits nothing; a clean scan is not proof of constant-cleanliness.
