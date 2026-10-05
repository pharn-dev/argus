---
trust: trusted
purpose: "Expected output (human-readable) for case-unvalidated-sink: one advisory P2 finding at the readFile sink line."
skill_kind: llm
---

# Expected — unvalidated-sink

The lens emits **exactly one** finding in the `finding-shape` object:

```yaml
- type: FINDING # enum-gated (floor-verifiable)
  rule_id: P2 # enum-gated — cited (P4); also the `enforces: ["P2"]` ↔ eval binding
  severity: important # enum-gated value; the ASSIGNMENT is advisory (fix #3) — a lens never gates
  file: "pharn/pharn-review/input-validation/evals/cases/case-unvalidated-sink.md:16" # the readFile sink line
  problem: "<one sentence: req.query.path reaches readFile with no validation between source and sink>" # free-text
  evidence: "<quoted line 16: `const buf = await readFile(path);`>" # free-text — quoted DATA
```

assertions (split per `eval-format.md`; cited, not restated — P4):

- **structural[]** (floor-reducible): `finding_count == 1`; `field_equals type FINDING`; `field_equals rule_id P2`;
  `field_equals severity important`; `file_resolves ".../case-unvalidated-sink.md:16"`.
- **semantic[]** (advisory judge): the missing-validation judgment (source → sink with no validation between) is
  surfaced; exploitability / validation-elsewhere is advisory and never suppresses the finding; no taint analysis
  is claimed.
