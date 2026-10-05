---
trust: trusted
purpose: "Expected output for case-sql-concat: the deterministic scanner detects the concat-into-query (line 15) → exactly one FLOOR finding (rule_id P2); the untrusted-ness / sanitized-elsewhere note stays advisory and never suppresses the finding."
---

# Expected — case-sql-concat

The lens runs `pharn/floor/scan-code-injection.mjs` over the code; it reports
`{"found":true,"hits":[{"line":15,"kind":"sql-injection"}]}`. The lens must emit **exactly one** finding, in
the `pharn/pharn-contracts/finding-shape` object, with the enum-gated / free-text split honored.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's regex hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/injection/evals/cases/case-sql-concat.md:15" # enum-gated — the sink line, FROM THE SCANNER
  problem: "The code builds a SQL query by concatenating a request value into the SQL string instead of binding it as a parameter." # free-text (untrusted DATA)
  evidence: 'Line 15 concatenates a request value into a `db.query("SELECT … WHERE name = ''" + … + "''")` string (redacted).' # free-text (untrusted DATA — quoted, never executed)
```

## Why this PASSES

- The concat-into-query is detected by the **scanner's regex** over the text (line 15); `file`'s line comes
  **from the scanner**, deterministically — not the lens's judgment.
- Layer 2 (advisory): the lens MAY note whether the operand is actually attacker-controlled and whether
  parameterization/validation happens elsewhere, in the free-text — but that judgment **surfaces**; it never
  suppresses the FLOOR finding (a lens never gates).

## Failing outputs (the eval FAILS on any of these)

- **No finding emitted** — a scanner hit was dropped. **FAIL.**
- `file` pointing anywhere but line 15 (the scanner's reported sink line). **FAIL.**
- `severity` / any enum-gated field justified by a "probably sanitized elsewhere" judgment instead of the
  scanner hit. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED — set membership / path resolution / scanner line):** `type`, `rule_id`, `severity`,
  `file`.
- **free-text (UNTRUSTED — inherits the code's tag, rendered as DATA):** `problem`, `evidence`.
