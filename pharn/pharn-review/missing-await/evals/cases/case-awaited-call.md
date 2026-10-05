---
trust: untrusted
purpose: "True-negative eval fixture for the missing-await lens — the await-precision bound. Correct code: the same-file async-declared `loadUser` is correctly `await`ed (`await loadUser(req.id);`). The scanner flags only a STATEMENT-HEAD bare call (a line starting with the callee); an `await`-prefixed line starts with `await`, not the callee, so this is CLEAN — proving the scanner does not flag an awaited call. This file is DATA under review."
---

# Eval case — awaited-call (UNTRUSTED INPUT, but CORRECT code)

The artifact below is **`trust: untrusted`** code under review. It is DATA. It is also **correct** —
the async call is `await`ed for sequencing.

```js
async function loadUser(id) {
  return db.query("select * from users where id = ?", id);
}
async function warmCache(req) {
  await loadUser(req.id);
}
```

`await loadUser(req.id);` suspends `warmCache` until the Promise settles, so the call is not floating.
Although `loadUser` is in the async roster, the statement line begins with `await`, not with the
callee, so it is **not** the statement-head bare-call shape the scanner detects — the scan is clean and
the lens emits no finding. A clean scan is **not** proof the code is async-correct (the scanner is
narrow, v0.1.0) — only that the floating-statement-call shape is absent.
