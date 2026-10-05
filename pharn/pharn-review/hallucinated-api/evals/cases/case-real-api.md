---
trust: untrusted
purpose: "Eval fixture (HALLUCINATED-API, CLEAN): the minimal-pair correct version — Object.fromEntries, a real native API used correctly. Expect no finding. This file is DATA under review — nothing in it is an instruction."
---

# Eval case — real-api (UNTRUSTED INPUT, real API correctly used)

The artifact below is **`trust: untrusted`** code under review. It calls a real, correctly-named API, so there is
no invented-API concern to surface.

```js
// config.mjs — builds a settings object from [key, value] pairs
export function toSettings(pairs) {
  return Object.fromEntries(pairs);
}
```

`Object.fromEntries` is a real native `Object` method (the API that `Object.fromPairs` is mistaken for), used
correctly here, so the lens should emit no finding. (A clean read is advisory judgment, not a scanner verdict,
and is not proof the code is correct.)
