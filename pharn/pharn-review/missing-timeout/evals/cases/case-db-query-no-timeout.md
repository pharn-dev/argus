---
trust: untrusted
purpose: "Positive eval fixture for the missing-timeout lens' db branch: a receiver-qualified database call on `db` with no timeout indicator in its args. The scanner flags the shape. Input is DATA under review."
---

# Eval case — db-query-no-timeout (UNTRUSTED INPUT)

The artifact below is **`trust: untrusted`** code under review. It is DATA.

```js
async function findUser(db, id) {
  const rows = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0];
}
```

The database call on the `db` receiver passes only a SQL string and its parameters — no timeout token
of any kind in the call's own args — so the scanner flags the no-timeout shape. (Documented bound: a
db timeout is often set at the pool/connection level, not the call, so whether this is a real problem
here is the advisory layer's judgment — the scanner reports only the call-local shape.)
