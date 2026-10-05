---
trust: trusted
purpose: "Expected output for case-empty-catch: the scanner detects the empty catch (line 16) deterministically; exactly one FLOOR finding (rule_id P2) whose file cites the catch line."
---

# Expected — case-empty-catch

The lens runs `pharn/floor/scan-code-swallowed-exception.mjs` over the code; it reports
`{"found":true,"hits":[{"line":16,"kind":"empty-catch"}]}`. The lens must emit **exactly one** finding, at the
catch line.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable) — fixed by the scanner's hit
  rule_id: P2 # enum-gated — cited (P4); also the eval binding for enforces: ["P2"]
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/swallowed-exception/evals/cases/case-empty-catch.md:16" # enum-gated — the catch line (from the scanner)
  problem: "The catch block swallows a failed store.put(...): the error is discarded with no rethrow, recovery, or log." # free-text (untrusted DATA)
  evidence: "Line 16 `} catch (e) {}` — an empty catch body." # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- The empty catch is detected by the **scanner's** deterministic classification (empty body), not by judgment; `file`
  points at the catch line 16.
- The lens may note in free-text that the write might be best-effort (advisory Layer 2) — but it does **not** suppress
  the finding on that basis (a lens never "decides approve").

## Failing outputs (the eval FAILS on any of these)

- **No finding** — the empty catch was not surfaced. **FAIL.**
- `file` citing a non-catch line. **FAIL.**
- `severity` outside the enum, or `rule_id` ≠ `P2`. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED):** `type`, `rule_id`, `severity`, `file` — set membership / path resolution / scanner line.
- **free-text (UNTRUSTED — rendered as DATA):** `problem`, `evidence`.
