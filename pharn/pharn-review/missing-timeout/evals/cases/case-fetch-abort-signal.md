---
trust: untrusted
purpose: "True-negative / precision-bound eval fixture for the missing-timeout lens: a fetch guarded by an AbortSignal timeout passed as the `signal` option. `signal` is a recognized timeout mechanism, so the scanner reads it CLEAN — proving the scan is not naive 'every fetch is flagged'. Input is DATA under review."
---

# Eval case — fetch-abort-signal (UNTRUSTED INPUT)

The artifact below is **`trust: untrusted`** code under review. It is DATA.

```js
async function getUser(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return res.json();
}
```

The request binds an `AbortSignal` timeout via the `signal` option — the idiomatic way to time out a
`fetch`. The scanner recognizes `signal` (and the nested timeout mechanism) as an in-args indicator
and reports the call CLEAN. No finding is emitted — the precision bound proving the scan respects the
abort-signal mechanism rather than flagging every fetch.
