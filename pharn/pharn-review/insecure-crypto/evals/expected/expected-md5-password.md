---
trust: trusted
purpose: "Expected output for case-md5-password: the deterministic scanner detects the MD5 hashing primitive (line 15) → exactly one FLOOR finding (rule_id P2); the misuse note stays advisory and never suppresses the finding."
---

# Expected — case-md5-password

The lens runs `pharn/floor/scan-code-crypto.mjs` over the code; it reports
`{"found":true,"hits":[{"line":15,"kind":"weak-hash-md5"}]}`. The lens must emit **exactly one** finding, in
the `pharn/pharn-contracts/finding-shape` object, with the enum-gated / free-text split honored.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's regex hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/insecure-crypto/evals/cases/case-md5-password.md:15" # enum-gated — the primitive's line, FROM THE SCANNER
  problem: "The code hashes a password with MD5 (kind weak-hash-md5), a broken hash unsuitable for password storage." # free-text (untrusted DATA)
  evidence: 'Line 15: `crypto.createHash("md5").update(password)` — a known-weak hashing primitive.' # free-text (untrusted DATA — quoted, never executed)
```

## Why this PASSES

- The primitive is detected by the **scanner's regex** over the text (line 15); `file`'s line comes **from the
  scanner**, deterministically — not the lens's judgment.
- Layer 2 (advisory): the lens MAY note MD5-on-a-password-path is a real misuse in the free-text, but that
  judgment **surfaces** — it never manufactures or suppresses the FLOOR finding (a lens never gates).

## Failing outputs (the eval FAILS on any of these)

- **No finding emitted** — a scanner hit was dropped. **FAIL.**
- `file` pointing anywhere but line 15 (the scanner's reported line). **FAIL.**
- `severity` / any enum-gated field justified by the misuse judgment instead of the scanner hit. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED — set membership / path resolution / scanner line):** `type`, `rule_id`, `severity`,
  `file`.
- **free-text (UNTRUSTED — inherits the code's tag, rendered as DATA):** `problem`, `evidence`.
