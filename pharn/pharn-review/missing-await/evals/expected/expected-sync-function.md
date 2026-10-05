---
trust: trusted
purpose: "Expected output for case-sync-function. A floating statement call whose callee is a plain synchronous function (not declared `async`) is NOT in the scanner's same-file async roster, so the scan is clean and the lens emits NO finding. Encodes the roster-precision bound: the scanner flags only a floating call to a known-async callee, not every floating statement call."
---

# Expected — sync-function

The lens must emit **zero** findings. `logAccess(req.id);` is a bare statement call syntactically
identical to a floating async call, but `logAccess` is a plain synchronous function — not declared
`async` anywhere in the file — so the scanner's same-file async roster is empty, `found:false`, and the
lens does not manufacture a finding.

## The expected output

```yaml
[] # no findings — findings.json is the empty array
```

## Why this PASSES — the roster-precision bound (the assertion that matters)

- `pharn/floor/scan-code-missing-await.mjs` reports `found:false`: the roster (names the file declares
  `async function NAME(` / `NAME = async`) is **empty**, so the statement-head call `logAccess(req.id);`
  is not a roster call and is not flagged.
- This proves the scanner is **roster-gated** — it does **not** flag every floating statement call
  (which would make `logAccess(req.id);`, `res.send(...)`, and every void call a finding), only a
  floating call to a **known-async** callee. The roster is the precision that makes this "missing await"
  rather than "any floating call."
- The lens emits **no** finding and does **not** invent one.

## Structural (eval-format.md — cited, not restated, P4)

`expected-sync-function.json` (`skill_kind: llm`): `structural[]` = `finding_count == 0` (floor-reducible
via `check-structural.mjs`); `semantic[]` = one advisory judge that the clean scan follows from the
empty roster (a sync callee), and that a clean scan is **not** proof of async-correctness (the Layer-1
bound).

## The honest bound (P0)

A clean scan means only that **no floating-statement-call to a same-file async-declared function** was
detected. It is **not** a guarantee the code is async-correct. This true-negative pins the
roster-precision boundary: the scanner does not over-flag a floating call to a synchronous callee.
