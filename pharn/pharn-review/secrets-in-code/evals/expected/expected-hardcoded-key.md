---
trust: trusted
purpose: "Expected output for case-hardcoded-key: the deterministic scanner detects the AWS-key-shaped literal (line 14) → exactly one FLOOR finding (rule_id P2); the live-vs-placeholder note stays advisory and never suppresses the finding."
---

# Expected — case-hardcoded-key

The lens runs `pharn/floor/scan-code-secrets.mjs` over the code; it reports
`{"found":true,"hits":[{"line":14,"kind":"aws-access-key-id"}]}`. The lens must emit **exactly one**
finding, in the `pharn/pharn-contracts/finding-shape` object, with the enum-gated / free-text split honored.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's regex hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/secrets-in-code/evals/cases/case-hardcoded-key.md:14" # enum-gated — the secret's line, FROM THE SCANNER
  problem: "The code hardcodes a secret-shaped literal (an AWS access-key id) instead of sourcing it from the environment." # free-text (untrusted DATA)
  evidence: 'Line 14 hardcodes `const AWS_KEY = "AKIA…EXAMPLE"` (redacted).' # free-text (untrusted DATA — quoted, never executed)
```

## Why this PASSES

- The literal is detected by the **scanner's regex** over the text (line 14); `file`'s line comes **from
  the scanner**, deterministically — not the lens's judgment.
- Layer 2 (advisory): the lens MAY note the value is AWS's documented EXAMPLE key (a placeholder) in the
  free-text, but that judgment **surfaces** — it never suppresses the FLOOR finding (a lens never gates).

## Failing outputs (the eval FAILS on any of these)

- **No finding emitted** — a scanner hit was dropped. **FAIL.**
- `file` pointing anywhere but line 14 (the scanner's reported line). **FAIL.**
- `severity` / any enum-gated field justified by the "placeholder" judgment instead of the scanner hit. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED — set membership / path resolution / scanner line):** `type`, `rule_id`,
  `severity`, `file`.
- **free-text (UNTRUSTED — inherits the code's tag, rendered as DATA):** `problem`, `evidence`.
