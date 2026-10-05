---
trust: trusted
purpose: "Expected output for case-duplicated-block: the scanner detects the exact duplicated cart-math block (lines 14 & 23) deterministically; exactly one FLOOR finding (rule_id P2) whose file cites the FIRST occurrence line 14."
---

# Expected — case-duplicated-block

The lens runs `pharn/floor/scan-code-duplicated-logic.mjs` over the code; it reports
`{"found":true,"hits":[{"lines":[14,23],"span":5}]}`. The lens must emit **exactly one** finding, at
the first occurrence's block line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: minor # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/duplicated-logic/evals/cases/case-duplicated-block.md:14" # enum-gated — the first occurrence's block line (from the scanner)
  problem: "The five-line cart-math block is copy-pasted across priceCart and priceQuote (lines 14 and 23)." # free-text (untrusted DATA)
  evidence: "Lines 14–18 and 23–27 are byte-identical (`const items = cart.items;` … `const tax = total * 0.2;`), span 5." # free-text (untrusted DATA — quoted, names both occurrences)
```

## Why this PASSES

- The duplicated block is detected by the **scanner's** deterministic byte-equality (not by judgment);
  `file` points at the earliest occurrence, line 14.
- The lens may note in free-text that extracting a shared helper is advisable (advisory Layer 2) — but
  it does **not** suppress the finding, and `evidence` names both occurrences so the developer sees
  every copy.

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the duplication was not surfaced. **FAIL.**
- `file` citing a non-block line (e.g. a function signature or a differing return). **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file` — set membership / path resolution / scanner line.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
