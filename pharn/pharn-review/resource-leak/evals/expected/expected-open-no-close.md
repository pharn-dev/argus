---
trust: trusted
purpose: "Expected output for case-open-no-close: the scanner detects the unclosed fs.openSync handle (line 16) deterministically; exactly one FLOOR finding (rule_id P2) whose file cites the binding line."
---

# Expected — case-open-no-close

The lens runs `pharn/floor/scan-code-resource-leak.mjs` over the code; it reports
`{"found":true,"hits":[{"line":16,"kind":"unclosed-resource"}]}`. The lens must emit **exactly one**
finding, at the binding (acquisition) line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/resource-leak/evals/cases/case-open-no-close.md:16" # enum-gated — the binding line (from the scanner)
  problem: 'The file handle opened with fs.openSync(path, "a") is never closed: no close call on the binding, no finally, no using.' # free-text (untrusted DATA)
  evidence: 'Line 16 `const fd = fs.openSync(path, "a");` — the binding is never cleaned up in this file.' # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- The unclosed handle is detected by the **scanner's** deterministic classification (a fixed-set open
  binding with no cleanup call on the binding), not by judgment; `file` points at the binding line 16.
- The lens may note in free-text that a caller might close it elsewhere (advisory Layer 2) — but it does
  **not** suppress the finding on that basis (a lens never "decides approve").

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the unclosed resource was not surfaced. **FAIL.**
- `file` citing a non-binding line. **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file` — set membership / path resolution / scanner line.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
