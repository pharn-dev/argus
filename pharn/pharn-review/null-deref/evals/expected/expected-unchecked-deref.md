---
trust: trusted
purpose: "Expected output for case-unchecked-deref: the scanner detects the unchecked deref (line 15) deterministically; exactly one FLOOR finding (rule_id P2) whose file cites the deref line."
---

# Expected — case-unchecked-deref

The lens runs `pharn/floor/scan-code-null-deref.mjs` over the code; it reports
`{"found":true,"hits":[{"line":15,"kind":"unchecked-deref"}]}`. The lens must emit **exactly one**
finding, at the deref line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/null-deref/evals/cases/case-unchecked-deref.md:15" # enum-gated — the deref line (from the scanner)
  problem: "`u.email` dereferences a value from `users.find(...)` (which can return undefined) with no null-check between the binding and the deref." # free-text (untrusted DATA)
  evidence: "Line 14 `const u = users.find((x) => x.id === id);` then line 15 `return u.email;` — no guard between." # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- The unchecked deref is detected by the **scanner's** deterministic first-occurrence classification
  (the first use of `u` is a raw `.email` deref), not by judgment; `file` points at the deref line 15.
- The lens may note in free-text that `u` might be safe by an invariant (advisory Layer 2) — but it
  does **not** suppress the finding on that basis (a lens never "decides approve").

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the unchecked deref was not surfaced. **FAIL.**
- `file` citing a non-deref line (e.g. the assignment or a comment). **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file` — set membership / path resolution / scanner line.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
