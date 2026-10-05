---
trust: trusted
purpose: "Expected output for case-empty-body: the scanner detects the empty function body (line 13) deterministically via the masked brace-match; exactly one FLOOR finding (rule_id P2) whose file cites the function-head line."
---

# Expected — case-empty-body

The lens runs `pharn/floor/scan-code-placeholder.mjs` over the code; it reports
`{"found":true,"hits":[{"line":13,"kind":"empty-body"}]}`. The lens must emit **exactly one** finding, at the
function-head line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/placeholder-as-done/evals/cases/case-empty-body.md:13" # enum-gated — the function-head line (from the scanner)
  problem: "The applyTax function has an empty body where the tax calculation is expected — a placeholder shipped as done." # free-text (untrusted DATA)
  evidence: "Line 13 `export function applyTax(order, region) {}` — an empty function body." # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- The empty body is detected by the **scanner's** deterministic Pass B (mask comments/strings, brace-match the body,
  body whitespace-only), not by judgment; `file` points at the function-head line 13.
- The lens may note in free-text that an empty body could be a deliberate no-op (advisory) — but it does **not**
  suppress the finding on that basis.

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the empty body was not surfaced. **FAIL.**
- `file` citing a non-function line. **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file` — set membership / path resolution / scanner line.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
