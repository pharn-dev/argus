---
trust: trusted
purpose: "Expected output for case-unguarded-await: the scanner detects one unguarded awaited call (line 14); the lens emits exactly one FLOOR finding citing that line."
---

# Expected — case-unguarded-await

The lens runs `pharn/floor/scan-code-missing-error-handling.mjs` over the code; it reports
`{"found":true,"hits":[{"line":14,"kind":"unguarded-await"}]}`. The lens emits **exactly one** finding.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated value; the lens's assessment (advisory, fix #3) — a lens never gates
  file: "pharn/pharn-review/missing-error-handling/evals/cases/case-unguarded-await.md:14" # enum-gated — the awaited call (from the scanner)
  problem: "The awaited network call has no surrounding try/catch and no .catch handler; a rejection would be unhandled." # free-text (untrusted DATA)
  evidence: 'Line 14 `const res = await fetch("/api/users/" + id);` at function scope, outside any try block.' # free-text (untrusted DATA — quoted, never executed)
```

## Why this PASSES

- The unguarded awaited call is detected by the **scanner** (found:true), so `file` points at line 14.
- Layer 2 (advisory) may note whether the caller handles the rejection — surfaced for the human, never a floor claim.
- A clean scan on other code would **not** prove error-safety (Layer-1 bound); this case is a real hit.

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED — set membership / path resolution / scanner line):** `type`, `rule_id`, `severity`, `file`.
- **free-text (UNTRUSTED — inherits the code's tag, rendered as DATA):** `problem`, `evidence`.
