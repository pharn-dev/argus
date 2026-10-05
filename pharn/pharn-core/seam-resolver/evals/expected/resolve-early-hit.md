---
trust: trusted
purpose: "The walk stops at official-skill; later steps are unreached."
skill_kind: llm
---

# Expected — resolve-early-hit

The resolver is not a finding-emitter; `eval-format.md`'s `structural[]` kinds range over
finding-shape fields only, so they do not apply to a walk-decision (see `PLAN.md`). The walk outcome
is therefore asserted in `semantic[]` (advisory), consistent with the guarantee audit.

```yaml
assertions:
  structural: []
  semantic:
    - judge: "The resolver resolves the seam via the `official-skill` step and STOPS there — it does not walk to `pinned-docs`, `model`, `fetch`, or `ask`."
    - judge: "The resolved-via step reported is `official-skill`, a member of the seam-config step enum — not an invented source."
    - judge: "The confidence gate is never consulted, because the walk stopped before the `model` step."
```
