---
trust: trusted
purpose: "Expected output for plan-decoupled: explicit immutable data flow with the shared shape routed through pharn-contracts is the decoupled shape — the coupling griller raises no entanglement finding (finding_count == 0)."
---

# Expected — plan-decoupled

The griller must raise **no** entanglement finding — `finding_count == 0` (the empty array `[]`).

## Why this PASSES

- `timer` returns its result and `reporter` receives it as an explicit argument — the dependency is
  **explicit and immutable**, with no shared mutable state and no hidden write-order between the two
  modules.
- The only shared thing is `pharn/pharn-contracts/timing-shape.md` (the bottom of the tree), depended on by
  both and referenced by neither module directly — clean seams, no entanglement.

## FAILING outputs (the eval FAILS on any of these)

- Any finding emitted — the griller invented an entanglement concern where the data flow is explicit and
  immutable. **FAIL.**
- A `rule_id: P3` finding treating a legitimate shared **contract** (an immutable abstraction routed
  through `pharn-contracts`) as coupling. **FAIL** — that is the architecture-endorsed shape, not
  entanglement.

## Trust-class check (P2, fix #1)

- No untrusted needle is present in this fixture; the assertion is simply that a clean, decoupled plan
  produces the empty finding list `[]`.
