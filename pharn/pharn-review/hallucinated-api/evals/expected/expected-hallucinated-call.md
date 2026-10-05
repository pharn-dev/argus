---
trust: trusted
purpose: "Expected output (human-readable) for case-hallucinated-call: one advisory P2 finding at the Object.fromPairs call line."
skill_kind: llm
---

# Expected — hallucinated-call

The lens emits **exactly one** finding in the `finding-shape` object:

```yaml
- type: FINDING # enum-gated (floor-verifiable)
  rule_id: P2 # enum-gated — cited (P4); also the `enforces: ["P2"]` ↔ eval binding
  severity: important # enum-gated value; the ASSIGNMENT is advisory (fix #3) — a lens never gates
  file: "pharn/pharn-review/hallucinated-api/evals/cases/case-hallucinated-call.md:14" # the Object.fromPairs call line
  problem: "<one sentence: Object.fromPairs is called but does not exist on native Object; the real API is Object.fromEntries>" # free-text
  evidence: "<quoted line 14: `return Object.fromPairs(pairs);`>" # free-text — quoted DATA (untrusted)
```

assertions (split per `eval-format.md`; cited, not restated — P4):

- **structural[]** (floor-reducible, checked at eval-time by `check-structural.mjs`): `finding_count == 1`;
  `field_equals type FINDING`; `field_equals rule_id P2`; `field_equals severity important`;
  `file_resolves ".../case-hallucinated-call.md:14"`. **Honest note (P0):** on this advisory `llm` lens,
  `finding_count == 1` pins the EXPECTED output of a model judgment (does this API exist?), **not** a
  deterministic API-existence computation — the model's conformance is advisory (there is no scanner).
- **semantic[]** (advisory judge): the invented-API judgment (Object.fromPairs is not real on Object) is
  surfaced; real-but-obscure / re-export / monkey-patch is advisory and never suppresses; no taint analysis or
  external lookup is claimed.
