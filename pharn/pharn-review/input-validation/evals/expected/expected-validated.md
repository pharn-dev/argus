---
trust: trusted
purpose: "Expected output (human-readable) for case-validated: no finding — the input is validated against an allow-list before the sink."
skill_kind: llm
---

# Expected — validated (clean)

The lens emits **no** finding — the empty array `[]`. `req.query.name` is validated against the `ALLOWED`
allow-list before it reaches `readFile`, so there is no missing-validation concern to surface (the axis is still
`rule_id P2`; the count is simply 0).

assertions (split per `eval-format.md`; cited, not restated — P4):

- **structural[]** (floor-reducible): `finding_count == 0`.
- **semantic[]** (advisory judge): the clean verdict is **advisory model judgment**, not a deterministic scanner
  result (this lens has no scanner) — and a clean read is **not** proof the code is safe. It must not be read as a
  deterministic "validated" guarantee.
