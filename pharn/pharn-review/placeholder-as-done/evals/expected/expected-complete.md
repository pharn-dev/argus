---
trust: trusted
purpose: "Expected output for case-complete: the scanner finds no placeholder marker and a non-empty body, so it reports found:false; the lens emits NO finding."
---

# Expected — case-complete

The lens runs `pharn/floor/scan-code-placeholder.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The lens must emit **zero** findings.

## The expected output

No finding. `findings.json` is the empty array `[]`.

## Why this PASSES

- There is no placeholder marker (Pass A clean) and the function body does real work (Pass B: body not
  whitespace-only), so the scanner reports `found:false`; the lens emits **no** finding and does not manufacture one.
- A clean scan is **not** proof the code is complete — the scanner detects only the fixed marker set plus the
  empty-body shape (Layer-1 bound). It only means no placeholder marker or empty function body was detected.

## Failing outputs (the eval FAILS on any of these)

- **A manufactured finding** on code the scanner reports clean. **FAIL.**
- Any nonzero `finding_count`. **FAIL.**

## Trust-class check (P2, fix #1)

- No finding emitted; there is no enum-gated or free-text field to range over. The empty array is the honest output.
