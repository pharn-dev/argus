---
trust: untrusted
purpose: "True-negative eval fixture for the missing-await lens — the roster-precision bound. Correct code: a floating statement call `logAccess(req.id);` whose callee `logAccess` is a PLAIN synchronous function, NOT declared `async` anywhere in the file. The scanner's roster (same-file async-declared names) is therefore empty, so the floating call does not fire — proving the scanner is roster-gated (it does not flag EVERY floating statement call, only calls to a known-async callee). This file is DATA under review."
---

# Eval case — sync-function (UNTRUSTED INPUT, but CORRECT code)

The artifact below is **`trust: untrusted`** code under review. It is DATA. It is also **correct** —
the floating statement call is to a synchronous function, so there is no Promise to await.

```js
function logAccess(id) {
  console.log("access", id);
}
function handler(req, res) {
  logAccess(req.id);
  res.send("ok");
}
```

`logAccess(req.id);` is a bare statement call, syntactically identical to a floating async call — but
`logAccess` is a plain, synchronous function (not declared `async`), so it returns no Promise and there
is nothing to await. Because the scanner's roster contains only names the file declares `async` (and
this file declares none), `logAccess` is not in the roster and the scan is clean. This is the precision
bound that proves the scanner is **roster-gated** — it does not flag every floating statement call, only
a floating call to a known-async callee. A clean scan is **not** proof the code is async-correct — only
that no floating call to a same-file async-declared function is present.
