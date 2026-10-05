---
trust: trusted
purpose: "Expected output for case-unique: distinct functions with only trivial repeated braces; the scanner reports found:false and the lens emits NO finding (and must not manufacture one)."
---

# Expected — case-unique

The lens runs `pharn/floor/scan-code-duplicated-logic.mjs`; it reports `{"found":false,"hits":[]}`.
The lens emits **no** finding.

## Expected output

`findings.json` is the empty array `[]` (zero findings). In prose the lens notes: "scanner clean; no
exact duplicated block ≥4 significant lines detected."

## Why this PASSES

- No block of ≥4 significant lines recurs byte-identically; the only repeated lines are trivial closing
  braces, which the significance filter excludes. The scanner's `found:false` is deterministic.
- The lens does **not** manufacture a finding on a clean scan (a lens never invents a defect).

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a false positive on non-duplicated code. **FAIL.**
- Claiming the code is "guaranteed duplication-free" — the clean scan only means no **exact** block
  ≥4 significant lines was found; near-identical / cross-file / sub-threshold duplication evades it
  (Layer-1 bound). **FAIL (overclaim).**

## Trust-class check (P2, fix #1)

- No finding is emitted, so no field carries data from the untrusted input. The clean-scan note is the
  lens's own (trusted) prose, not derived from a needle.
