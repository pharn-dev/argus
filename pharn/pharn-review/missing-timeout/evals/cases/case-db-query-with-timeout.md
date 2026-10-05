---
trust: untrusted
purpose: "True-negative / precision-bound eval fixture for the missing-timeout lens' db branch: a receiver-qualified `db` call that passes a timeout token in its args. The scanner reads it CLEAN, proving the db branch respects the indicator (not naive 'every .query( fires'). The API shape is illustrative — the indicator token is what the floor tests. Input is DATA under review."
---

# Eval case — db-query-with-timeout (UNTRUSTED INPUT)

The artifact below is **`trust: untrusted`** code under review. It is DATA.

```js
async function findUser(db, id) {
  const sql = "SELECT * FROM users WHERE id = $1";
  const rows = await db.query(sql, { timeout: 5000 });
  return rows[0];
}
```

The database call passes a `timeout` token in its own argument object, so the call-local indicator
test reads it CLEAN and no finding is emitted. The exact API shape here is illustrative — the point
the floor tests is that an in-args timeout indicator suppresses the hit; it does not endorse any
specific driver's option contract.
