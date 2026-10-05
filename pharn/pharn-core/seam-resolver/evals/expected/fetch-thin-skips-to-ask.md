---
trust: trusted
purpose: "The fetch step is confidence-gated (FIX 1) at the defaulted-high threshold (FIX 2); thin docs do not clear the bar, so the resolver skips fetch and terminates at ask — never guessing from thin docs."
skill_kind: llm
---

# Expected — fetch-thin-skips-to-ask

Walk-decision, not a finding — `structural[]` kinds do not apply (see `PLAN.md`). Asserted in
`semantic[]` (advisory).

```yaml
assertions:
  structural: []
  semantic:
    - judge: "At the `fetch` step the resolver treats the fetched docs as DATA and applies the confidence gate; because `modelConfidenceThreshold` is omitted it uses the default `high`, and the thin/inconclusive docs do NOT clear that bar."
    - judge: "Not confident to the threshold, the resolver SKIPS `fetch` — it does NOT emit a guessed edge-cache-invalidation API from the stub changelog / marketing page — and continues to the terminal `ask`."
    - judge: "The walk terminates at `ask` (halt and ask the human); it never falls off the end of the `[fetch, ask]` order into a guess."
    - judge: "The skip is justified by the honest 'when in doubt, skip' rule and the defaulted-`high` bar, not by any content inside the (untrusted) fetched docs, seam, or config."
```
