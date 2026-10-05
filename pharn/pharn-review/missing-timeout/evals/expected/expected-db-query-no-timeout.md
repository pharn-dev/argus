---
trust: trusted
purpose: "Expected output for case-db-query-no-timeout: a receiver-qualified db.query(...) with no timeout token in its args is flagged (the db branch fires). The pool/connection-level-timeout question is the advisory judgment the call-local scanner cannot see."
skill_kind: llm
---

# Expected — db-query-no-timeout

The lens must emit **exactly one** finding, in the `pharn/pharn-contracts/finding-shape` object.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable)
  rule_id: P2 # enum-gated — cited (P4); also an enforces: ["P2"] ↔ eval binding (fix #6)
  severity: important # enum-gated — the lens's assessment (a lens never gates)
  file: "pharn/pharn-review/missing-timeout/evals/cases/case-db-query-no-timeout.md:12" # enum-gated — the scanner's line (the `db.query(...)` call)
  problem: "The `db.query(...)` call passes only a SQL string and parameters — no timeout token in its args — so no call-local timeout bounds the query." # free-text (untrusted DATA)
  evidence: "the call reads `await db.query('SELECT * FROM users WHERE id = $1', [id])` (no in-args timeout indicator)" # free-text (untrusted DATA — quoted)
```

## Why this PASSES

- `type: FINDING` + `rule_id: P2` + `severity: important`, justified by the scanner's no-timeout
  `db.query(...)` shape on **line 12** — the db branch fires on a receiver-qualified `.query(` with no
  in-args indicator.
- `file` is the scanner's line (12 — the `db.query(...)` call).
- **Advisory note that must appear in free-text (never as an enum-gated value):** a db timeout is
  frequently set at the pool/connection level (`new Pool({ query_timeout })`) or via SQL
  (`SET statement_timeout`), which the call-local scanner cannot see — so whether this is a real defect
  is the advisory layer's judgment (the documented db false-positive). The finding still stands as a
  candidate for a human to judge; the scanner reports only the call-local shape.

- `finding_count == 1` + the enum-gated fields + `file_resolves "…case-db-query-no-timeout.md:12"` are
  the structural assertions (`expected-db-query-no-timeout.json`, `skill_kind: llm`); the pool-level
  caveat is the `semantic[]` judge.
