---
trust: trusted
purpose: "Expected output (human-readable) for case-real-api: no finding — Object.fromEntries is a real API correctly used."
skill_kind: llm
---

# Expected — real-api

The lens emits **no** finding (`finding_count == 0`): `Object.fromEntries` is a real native `Object` method,
used correctly, so there is no invented-API concern to surface.

assertions (split per `eval-format.md`; cited, not restated — P4):

- **structural[]** (floor-reducible): `finding_count == 0`. **Honest note (P0):** the clean count is a
  deterministic _check_, but the model's _conformance_ to it is ADVISORY judgment (this lens has no scanner); a
  clean read is **not** proof the code is correct.
- **semantic[]** (advisory judge): no finding because `Object.fromEntries` is real and correctly used; the clean
  read is advisory, not a scanner verdict.
