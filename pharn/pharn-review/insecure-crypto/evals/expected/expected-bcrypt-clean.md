---
trust: trusted
purpose: "Expected output for case-bcrypt-clean: the deterministic scanner names no weak primitive → the lens emits the empty finding array; a clean scan is NOT a claim the crypto is correct."
---

# Expected — case-bcrypt-clean

The lens runs `pharn/floor/scan-code-crypto.mjs` over the code; it reports `{"found":false,"hits":[]}`. bcrypt
is a salted adaptive KDF, and none of the fixed weak-primitive set (MD5, SHA-1, DES, ECB, insecure-random,
hardcoded-IV-salt) is named. The lens must emit **zero** findings — the empty array `[]`.

## The expected output

An empty finding array (`[]`): no finding object is produced, so there are no enum-gated fields (type,
rule-id, severity, file) and no free-text fields to populate.

## Why this PASSES

- The scanner names no weak primitive, so there is nothing to flag; the lens emits the empty array and does
  **not** manufacture a finding.
- Honest bound (P0): a clean scan means only that the **fixed weak-primitive set** is absent — it is **not** a
  claim that the code is cryptographically correct or secure overall. The lens must not word its prose as such.

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — the scanner is clean; a manufactured finding is a false positive. **FAIL.**
- Prose asserting "the crypto is correct / secure" on the strength of a clean scan (the struck over-claim, P0).
  **FAIL.**
