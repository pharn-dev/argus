---
trust: trusted
purpose: "Expected output for case-insecure-random: the scanner fires on the session-token RNG (line 17) and stays silent on the array-pick RNG (line 22) → exactly one FLOOR finding (rule_id P2). This is the kind's CONTEXT SCOPING under test, not merely its presence."
---

# Expected — case-insecure-random

The lens runs `pharn/floor/scan-code-crypto.mjs` over the case; it reports
`{"found":true,"hits":[{"line":17,"kind":"insecure-random"}]}` — **one** hit, not two. Both lines call the
same non-crypto RNG; only line 17 also names security material as an identifier segment
(`sessionToken` → the `Token` camelCase segment). Line 22's `keys` contains `key` as a **substring**, not
as a segment, so the context-scoped pattern does not fire.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable)
  rule_id: P2 # enum-gated — cited (P4)
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/insecure-crypto/evals/cases/case-insecure-random.md:17" # enum-gated — FROM THE SCANNER
  problem: "A non-cryptographic RNG generates a session token (kind insecure-random), so the issued token is predictable." # free-text (untrusted DATA)
  evidence: 'Line 17: `const sessionToken = "s_" + Math.random().toString(36).slice(2);`' # free-text (untrusted DATA)
```

## Why this PASSES

- The scanner fires on line 17 because the RNG call and a security-material **segment** share the line;
  `file`'s line comes **from the scanner** (17), never from the lens re-reading the code.
- The scanner does **not** fire on line 22, so no second finding exists to emit. The lens must not invent
  one: "there is another RNG call in this file" is Layer-2 judgment, and a lens that adds findings the
  floor did not produce is asserting a guarantee it does not have (P0).
- Exactly one finding is emitted — the count is the assertion that context scoping held.

## Failing outputs (the eval FAILS on any of these)

- **Two findings** (line 22 also flagged) — the false positive this kind's anchoring exists to prevent, and
  the exact defect repaired in `SKILLS_VERSION` 2.7.11. **FAIL.**
- **No finding** — the lens suppressed a real weak-RNG hit on its own judgment. **FAIL** (a lens never gates).
- `file` pointing anywhere but line 17 (the scanner's reported line). **FAIL.**
- `severity` or `rule_id` derived from the lens's prose reading rather than the scanner hit. **FAIL.**

## Why this case is worth its slot (P7 — a real failure, not a hypothetical)

The `insecure-random` kind shipped with the lens and had **no** committed lens eval; the gap was recorded at
the lens's own build (`.dev/features/crypto-lens/GRILL.md:35`) and again at
`.dev/features/secmat-word-boundary/GRILL.md`. Between those two surfacings the kind produced a real false
positive on ordinary code — a random pick over `Object.keys(...)` — which is why this fixture keeps **both**
RNG calls in one file: a case containing only the token line would pass identically before and after the
repair, and would therefore demonstrate nothing about the scoping.

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED — set membership / path resolution / scanner line):** `type`, `rule_id`, `severity`,
  `file`.
- **free-text (UNTRUSTED — the quoted code and the prose reading live here, as DATA):** `problem`, `evidence`.
