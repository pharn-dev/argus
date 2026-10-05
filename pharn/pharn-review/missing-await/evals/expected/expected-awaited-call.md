---
trust: trusted
purpose: "Expected output for case-awaited-call. The async call is correctly `await`ed, so the statement line begins with `await` (not the callee) and is not the statement-head bare-call shape the scanner detects — the scan is clean and the lens emits NO finding. Encodes the await-precision bound: an awaited call is not flagged."
---

# Expected — awaited-call

The lens must emit **zero** findings. The `await loadUser(req.id);` statement is a correctly-awaited
async call: although `loadUser` is in the same-file async roster, the line begins with `await`, not the
callee, so `pharn/floor/scan-code-missing-await.mjs` reports `found:false` and the lens does not
manufacture a finding.

## The expected output

```yaml
[] # no findings — findings.json is the empty array
```

## Why this PASSES

- `pharn/floor/scan-code-missing-await.mjs` reports `found:false`: the statement-head anchor `^\s*NAME(`
  requires the callee to be the first token on the line; `await loadUser(req.id);` begins with `await`,
  so it is not a hit. The call is awaited — not floating.
- The lens emits **no** finding and does **not** invent one. Emitting any finding here would be a
  false-positive: an awaited call is exactly the correct usage.

## Structural (eval-format.md — cited, not restated, P4)

`expected-awaited-call.json` (`skill_kind: llm`): `structural[]` = `finding_count == 0` (floor-reducible
via `check-structural.mjs`); `semantic[]` = one advisory judge that the clean scan follows from the
awaited call, and that a clean scan is **not** proof of async-correctness (the Layer-1 bound — the
scanner is narrow, v0.1.0).

## The honest bound (P0)

A clean scan means only that **no floating-statement-call to a same-file async-declared function** was
detected. It is **not** a guarantee the code is async-correct — an imported async call, an async-method
call, an assigned-then-unawaited result, or a roster call not at line-start would all evade this
scanner (documented scope). This true-negative pins the await-precision boundary, nothing broader.
