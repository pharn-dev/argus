---
trust: trusted
purpose: "Expected output for case-duplicated-function: the scanner detects the byte-identical handler body (lines 14 & 21); exactly one FLOOR finding (rule_id P2) whose file cites the first occurrence line 14."
---

# Expected — case-duplicated-function

The lens runs `pharn/floor/scan-code-duplicated-logic.mjs`; it reports
`{"found":true,"hits":[{"lines":[14,21],"span":5}]}`. Exactly **one** finding, at the first
occurrence's block line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: minor # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/duplicated-logic/evals/cases/case-duplicated-function.md:14" # enum-gated — the first occurrence's block line (from the scanner)
  problem: "handleCreate and handleUpdate have byte-identical five-line bodies (lines 14 and 21)." # free-text (untrusted DATA)
  evidence: "Lines 14–18 and 21–25 are identical (`const id = req.params.id;` … `return res.json({ ok, row });`), span 5." # free-text (untrusted DATA — names both occurrences)
```

## Why this PASSES

- The duplicated body is detected by the **scanner's** deterministic byte-equality; `file` points at
  the earliest occurrence, line 14.
- The lens may note (advisory Layer 2) that the handlers should share a helper or are about to diverge
  — but it does **not** suppress the finding.

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the duplicated body was not surfaced. **FAIL.**
- `file` citing a non-block line. **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file`.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
