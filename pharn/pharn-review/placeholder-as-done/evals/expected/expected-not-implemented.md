---
trust: trusted
purpose: "Expected output for case-not-implemented: the scanner detects the placeholder throw (line 14) deterministically; exactly one FLOOR finding (rule_id P2) whose file cites the throw line."
---

# Expected — case-not-implemented

The lens runs `pharn/floor/scan-code-placeholder.mjs` over the code; it reports
`{"found":true,"hits":[{"line":14,"kind":"not-implemented"}]}`. The lens must emit **exactly one** finding, at the
throw line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/placeholder-as-done/evals/cases/case-not-implemented.md:14" # enum-gated — the throw line (from the scanner)
  problem: "The invoice-total function ships a throw in place of the real calculation — a placeholder shipped as done." # free-text (untrusted DATA)
  evidence: 'Line 14 `throw new Error("not implemented");` — the whole function body.' # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- The placeholder throw is detected by the **scanner's** deterministic membership (Pass A, not-implemented), not by
  judgment; `file` points at the throw line 14.
- The lens may note in free-text that this could be a deliberate stub (advisory) — but it does **not** suppress the
  finding on that basis.

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the placeholder throw was not surfaced. **FAIL.**
- `file` citing a non-throw line. **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file` — set membership / path resolution / scanner line.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
