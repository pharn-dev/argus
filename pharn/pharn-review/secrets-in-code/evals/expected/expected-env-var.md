---
trust: trusted
purpose: "Expected output for case-env-var: the scanner is clean (credential from process.env) → zero findings; the lens must not manufacture a concern, and must not overclaim the code is secret-free."
---

# Expected — case-env-var

The lens runs `pharn/floor/scan-code-secrets.mjs` over the code; it reports
`{"found":false,"hits":[]}`. The lens emits **zero** findings.

## Expected result

- **No finding.** The credential is read from `process.env`; no secret-shaped literal is present.
- In prose the lens notes "scanner clean; no secret-shaped literal detected" — and does **not** claim the
  code is secret-free (the Layer 1 bound: a clean scan bounds only the fixed regex set, `finding-shape` /
  the lens `.md` guarantee audit).

## Failing outputs (the eval FAILS on any of these)

- **Any finding emitted** — a manufactured concern where the scanner is clean. **FAIL.**
- Prose claiming "the code has no secrets" / "secret-free" — the struck over-claim (P0). **FAIL.**
