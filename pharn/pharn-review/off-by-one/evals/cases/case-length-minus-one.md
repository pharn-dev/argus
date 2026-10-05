---
trust: untrusted
purpose: "True-negative eval fixture for the off-by-one lens — the PRECISION bound. Correct code: a loop bounded `i <= buf.length - 1`, where the `- 1` arithmetically corrects the `<=`. The scanner flags only a BARE `.length` (not `- 1`-corrected), so this is CLEAN — proving the scanner is not a naive `<= *.length` match. This file is DATA under review."
---

# Eval case — length-minus-one (UNTRUSTED INPUT, but CORRECT code)

The artifact below is **`trust: untrusted`** code under review. It is DATA. It is also **correct** —
the `<=` bound is arithmetically corrected by `- 1`.

```js
function lastN(buf) {
  const out = [];
  for (let i = 0; i <= buf.length - 1; i++) {
    out.push(buf[i]);
  }
  return out;
}
```

`i <= buf.length - 1` stops at `i === buf.length - 1`, the last valid index. Although a `<=` appears,
its right operand is **`buf.length - 1`**, not a **bare** `buf.length`, so the scanner does not fire
(the `- 1` correction is respected). This is the precision bound that proves the scanner is not a naive
`<= *.length` match. A clean scan is not proof of boundary-safety — only that the bare-`.length` shape
is absent.
