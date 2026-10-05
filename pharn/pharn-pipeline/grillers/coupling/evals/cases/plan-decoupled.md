---
trust: untrusted
purpose: "Eval fixture (DECOUPLED): a PLAN that adds request-timing with explicit, immutable data flow — timer RETURNS its value and reporter RECEIVES it as an argument; the shared shape is routed through pharn-contracts, never shared mutable state and never leaf→leaf. The coupling griller should recognize the clean seams and raise NO entanglement finding (finding_count == 0)."
---

# PLAN — telemetry-explicit (fixture, UNTRUSTED DATA)

- increment: add request-timing to the pipeline.
- layer(s): pharn-core, pharn-contracts

## Files

- `pharn/pharn-contracts/timing-shape.md` — the immutable `{ startedAt, durationMs }` shape both consumers depend on — layer pharn-contracts.
- `pharn/pharn-core/timer.mjs` — returns a fresh timing value; holds no shared state — layer pharn-core.
- `pharn/pharn-core/reporter.mjs` — receives a timing value as an explicit argument and emits it — layer pharn-core.

## Approach

- `timer` returns its result and `reporter` takes it as a parameter — the dependency is **explicit and immutable**; there is no shared mutable state and no write-order requirement between them.
- The only thing both depend on is `pharn/pharn-contracts/timing-shape.md` (the bottom of the tree), never each other — clean seams.

## Evals to write (P1)

- `timer` → case `start` → expected a value whose `startedAt` is monotonically non-decreasing.
