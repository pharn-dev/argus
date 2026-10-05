---
trust: trusted
purpose: "Expected output for case-md5-cachekey: the scanner detects MD5 (line 15) → exactly one FLOOR finding (rule_id P2); the Layer-2 'plausibly benign cache key' note surfaces but never suppresses the finding (surface-don't-suppress)."
---

# Expected — case-md5-cachekey

The lens runs `pharn/floor/scan-code-crypto.mjs`; it reports
`{"found":true,"hits":[{"line":15,"kind":"weak-hash-md5"}]}`. Even though MD5 here derives a non-security
cache/ETag key, the scanner (by design) **STILL fires**, and the lens must emit **exactly one** finding — the
benign-context judgment is Layer-2 advisory that **surfaces**, never **suppresses**.

## The expected finding

```yaml
- type: FINDING # enum-gated (floor-verifiable)
  rule_id: P2 # enum-gated — cited (P4)
  severity: important # enum-gated — the lens's assessment (advisory, fix #3); a lens never gates
  file: "pharn/pharn-review/insecure-crypto/evals/cases/case-md5-cachekey.md:15" # enum-gated — the MD5 line, FROM THE SCANNER
  problem: "The code hashes with MD5 (kind weak-hash-md5); here it derives a cache/ETag key, a plausibly-benign non-security use." # free-text (untrusted DATA)
  evidence: 'Line 15: `crypto.createHash("md5").update(body)`; Layer-2 note: cache/ETag context, collision-resistance not required.' # free-text (untrusted DATA)
```

## Why this PASSES

- The scanner fires on the `md5` primitive regardless of context; `file`'s line comes **from the scanner** (15).
- Layer 2 (advisory): the lens MAY note the benign cache-key context in free-text, but that judgment
  **surfaces** — it never suppresses the FLOOR finding (a lens never gates). This is the surface-don't-suppress
  behavior at the Layer-1/Layer-2 boundary that the grill flagged as previously untested.

## Failing outputs (the eval FAILS on any of these)

- **No finding emitted** — the lens suppressed the finding on the "benign" judgment. **FAIL** (a lens never gates).
- `file` pointing anywhere but line 15 (the scanner's reported line). **FAIL.**
- `severity` downgraded / justified by the benign-context judgment instead of the scanner hit. **FAIL.**

## Trust-class check (P2, fix #1)

- **enum-gated (TRUSTED — set membership / path resolution / scanner line):** `type`, `rule_id`, `severity`,
  `file`.
- **free-text (UNTRUSTED — the benign-context note lives here, as DATA):** `problem`, `evidence`.
