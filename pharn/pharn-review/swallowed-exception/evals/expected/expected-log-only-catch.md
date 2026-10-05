---
trust: trusted
purpose: "Expected output for case-log-only-catch: the scanner detects the log-only catch (line 16) deterministically; exactly one FLOOR finding (rule_id P2) whose file cites the catch line."
---

# Expected — case-log-only-catch

The lens runs `pharn/floor/scan-code-swallowed-exception.mjs` over the code; it reports
`{"found":true,"hits":[{"line":16,"kind":"log-only-catch"}]}`. The body only logs — no `throw` / `return` /
`reject` / `next(...)` — so the failure is swallowed. The lens must emit **exactly one** finding, at the catch line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/swallowed-exception/evals/cases/case-log-only-catch.md:16" # enum-gated — the catch line (from the scanner)
  problem: "The catch only logs the error and returns normally, so pushChanges resolves as if the push succeeded — the failure is swallowed." # free-text (untrusted DATA)
  evidence: 'Line 16 `} catch (e) {` whose body is only `console.error("push failed", e)` with no rethrow/return.' # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- The log-only body is classified by the **scanner** (a body of only recognized logging calls, no HANDLE token),
  deterministically; `file` points at the catch line 16, not the log line.
- The lens may note in free-text that a log-and-continue is sometimes acceptable (advisory Layer 2) — but it does
  **not** suppress the finding on that basis.

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the log-only swallow was not surfaced. **FAIL.**
- `file` citing the log line instead of the catch line. **FAIL.**
- `rule_id` ≠ `P2`, or a non-enum `severity`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file`.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
