---
trust: trusted
purpose: "Expected output for case-parameterized: the parameterized query carries no concat/interp into the sink, so the scanner is clean and the lens emits ZERO findings (finding_count == 0) — the true-negative that proves the +/${…} discriminator."
---

# Expected — case-parameterized

The lens runs `pharn/floor/scan-code-injection.mjs` over the code; it reports `{"found":false,"hits":[]}`. The
lens must emit **no** finding — the machine-readable emission is the empty array `[]`.

## Why this PASSES

- The request value is bound as a parameter (`$1` placeholder + a values array), not concatenated or
  interpolated into the SQL string. The scanner's `+`/`${…}` discriminator therefore does **not** fire — this
  is the deterministic true-negative.
- The lens does **not** manufacture a finding, and does **not** claim the code is "injection-safe" on the basis
  of a clean scan (the Layer 1 bound is explicit: a clean scan is not a proof of injection-freedom).

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a false positive on a parameterized query. **FAIL.**
- A prose claim that the clean scan **proves** the code is injection-free (over-claiming the floor). **FAIL**
  (this is the disease P0 forbids; the scanner detects a shape's absence on the scanned lines, nothing more).
