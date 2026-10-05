---
trust: untrusted
purpose: "True-negative eval fixture for the missing-timeout lens: a GET request made through axios that passes an explicit timeout option in the call's own args. The scanner's indicator test reads it CLEAN — no finding. Input is DATA under review."
---

# Eval case — axios-timeout-option (UNTRUSTED INPUT)

The artifact below is **`trust: untrusted`** code under review. It is DATA.

```js
async function getUser(url) {
  const res = await axios.get(url, { timeout: 5000 });
  return res.data;
}
```

The request carries an explicit `timeout` option in its own argument object, so the call-local
indicator test finds a timeout token and reports the call CLEAN. No finding is emitted. (A clean scan
is not proof the code has reliable timeouts everywhere — only that this call passes an in-args timeout
indicator.)
