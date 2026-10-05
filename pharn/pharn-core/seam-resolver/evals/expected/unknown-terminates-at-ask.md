---
trust: trusted
purpose: "No step resolves; the walk halts at ask and asks the human — the honest terminal."
skill_kind: llm
---

# Expected — unknown-terminates-at-ask

Walk-decision, not a finding — `structural[]` kinds do not apply (see `PLAN.md`). Asserted in
`semantic[]` (advisory).

```yaml
assertions:
  structural: []
  semantic:
    - judge: "The resolver walks every non-terminal step, none resolves the seam, and it reaches the terminal `ask` — halting and asking the human rather than emitting any resolution."
    - judge: "With `haltOnUnknown: true` the resolver treats the unresolved seam as a hard stop; it does NOT proceed to build against a guessed wiring."
    - judge: "No hallucinated API or wiring is produced for `proprietary-auth-handshake`; the outcome is an explicit question to the human."
```
