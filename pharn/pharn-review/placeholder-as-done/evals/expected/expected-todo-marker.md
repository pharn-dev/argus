---
trust: trusted
purpose: "Expected output for case-todo-marker: the scanner detects the to-do marker (line 14) deterministically; exactly one FLOOR finding (rule_id P2) whose file cites the marker line."
---

# Expected — case-todo-marker

The lens runs `pharn/floor/scan-code-placeholder.mjs` over the code; it reports
`{"found":true,"hits":[{"line":14,"kind":"todo"}]}`. The lens must emit **exactly one** finding, at the marker
line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/placeholder-as-done/evals/cases/case-todo-marker.md:14" # enum-gated — the marker line (from the scanner)
  problem: "A to-do comment marker was shipped in place of the read-through cache — unfinished work left as done." # free-text (untrusted DATA)
  evidence: "Line 14 `// TODO: cache the read-through result before shipping`." # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- The marker is detected by the **scanner's** deterministic membership (Pass A), not by judgment; `file` points at
  the marker line 14.
- The lens may note in free-text that the marker could be an intentional annotation (advisory) — but it does **not**
  suppress the finding on that basis (a lens never "decides approve").

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the placeholder marker was not surfaced. **FAIL.**
- `file` citing a non-marker line. **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file` — set membership / path resolution / scanner line.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
