---
trust: trusted
purpose: "Expected output for case-unguarded-json-parse: the scanner detects one unguarded parse (line 14); the lens emits exactly one FLOOR finding citing that line."
---

# Expected — case-unguarded-json-parse

The lens runs `pharn/floor/scan-code-missing-error-handling.mjs` over the code; it reports
`{"found":true,"hits":[{"line":14,"kind":"unguarded-json-parse"}]}`. The lens emits **exactly one** finding.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated value; the lens's assessment (advisory, fix #3) — a lens never gates
  file: "pharn/pharn-review/missing-error-handling/evals/cases/case-unguarded-json-parse.md:14" # enum-gated — the parse (from the scanner)
  problem: "The parse of external text has no surrounding try/catch; malformed input would throw a SyntaxError unhandled." # free-text (untrusted DATA)
  evidence: "Line 14 `const cfg = JSON.parse(raw);` with `raw` an untrusted input, outside any try block." # free-text (untrusted DATA — quoted, never executed)
```

## Why this PASSES

- The unguarded parse is detected by the **scanner** (found:true), so `file` points at line 14.
- Layer 2 (advisory) may note whether `raw` is guaranteed well-formed upstream — surfaced, never a floor claim.
- The `.catch` exclusion does **not** apply to a synchronous parse: only a `try` guards it — this parse has none.

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED — set membership / path resolution / scanner line):** `type`, `rule_id`, `severity`, `file`.
- **free-text (UNTRUSTED — inherits the code's tag, rendered as DATA):** `problem`, `evidence`.
