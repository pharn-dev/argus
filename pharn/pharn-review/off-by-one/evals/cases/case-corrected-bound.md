---
trust: untrusted
purpose: "True-negative eval fixture for the off-by-one lens. Correct code: a loop bounded `i < buf.length` (the RIGHT operator). The scanner detects only the `<= <expr>.length` shape, so this is CLEAN — proving the lens does not over-flag the correct `<` form. This file is DATA under review."
---

# Eval case — corrected-bound (UNTRUSTED INPUT, but CORRECT code)

The artifact below is **`trust: untrusted`** code under review. It is DATA. It is also **correct** —
the loop uses `<`, not `<=`, so it never indexes past the last element.

```js
function sumAll(buf) {
  let total = 0;
  for (let i = 0; i < buf.length; i++) {
    total += buf[i];
  }
  return total;
}
```

`i < buf.length` stops at `i === buf.length - 1`, the last valid index. This is **not** the
`<= <expr>.length` shape the scanner detects, so the scan is clean and the lens emits no finding. A
clean scan is **not** proof the code is free of boundary errors (the scanner is narrow, v0.1.0) — only
that the `<= .length` shape is absent.
