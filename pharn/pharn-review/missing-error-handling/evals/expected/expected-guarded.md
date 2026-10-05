---
trust: trusted
purpose: "Expected output for case-guarded: every risky op is guarded (try/catch or same-line .catch), so the scanner reports found:false and the lens emits NO finding. A clean scan is not proof the code is error-safe (a Layer-1 bound)."
---

# Expected — case-guarded

The lens runs `pharn/floor/scan-code-missing-error-handling.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The lens emits **no** finding — the expected findings array is `[]`.

## Why this PASSES

- The awaited fetch, the inner awaited read, and the parse are all inside the `try {…}` body → guarded (skipped).
- The `ping` awaited call carries a same-line `.catch(() => null)` handler → treated as inline-handled (skipped).
- With every risky op guarded, the scanner reports `found:false`; the lens does **not** manufacture a finding.
- A clean scan is **not** proof the code is error-safe (the Layer-1 bound): a custom throwing call outside the roster,
  a caller-handled await, or non-JS syntax would all evade the scanner. This case asserts only the true-negative shape.

## The expected output

```json
[]
```

An empty findings array — no finding object is emitted, so there is no enum-gated / free-text split to check here;
the assertion is purely `finding_count == 0`.
