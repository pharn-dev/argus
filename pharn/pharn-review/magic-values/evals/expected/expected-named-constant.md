---
trust: trusted
purpose: 'Expected output for case-named-constant: ZERO findings — the precision bound. The literals 5 and "guest" appear only as assignment RHS (named-constant definitions) and every comparison operand is a NAME or enum member, so the scanner reports found:false. Proves the scanner does not flag named constants (the fix for magic values) nor mistake the assignment that defines them for a comparison.'
---

# Expected — named-constant

The lens must emit **no** finding (the empty array `[]`).

## Why this PASSES — the GOOD pattern is left quiet (the precision bound)

- `pharn/floor/scan-code-magic-values.mjs` reports `found:false`. The literals `5` and `"guest"` appear
  only on the **right of an assignment** (`const MAX_RETRIES = 5;`, `const DEFAULT_ROLE = "guest";`) —
  the definition of a named constant. Assignment `=` is **not** a comparison operator, so the scanner
  deliberately does not flag it: **naming a value is the fix for a magic value, not the defect.**
- Every **comparison** operand is a NAME (`retries >= MAX_RETRIES`, `role === DEFAULT_ROLE`) or an enum
  member (`role === Role.ADMIN`) — never a bare literal — so no numeric or string hit fires.
- The lens emits **no** finding: it stays quiet exactly when the code is already well-named.

## Why this is the precision bound

A naive "flag any number / any string" scanner would wrongly flag the `= 5` / `= "guest"` definitions
(punishing the fix) or choke on the comparisons-against-names. This case proves the scanner is precise:
it fires only on a bare literal used as a **comparison** operand, so a codebase that has already
extracted its magic values into named constants and enums produces **zero** findings — the intended
end state.

## Structural (eval-format.md — cited, P4)

`expected-named-constant.json` (`skill_kind: llm`): **`structural[]` (1):** `finding_count == 0`.
**`semantic[]` (1, advisory):** the named-constant definitions and name/member comparison operands
justify `found:false`; the lens emits nothing — the precision bound.
