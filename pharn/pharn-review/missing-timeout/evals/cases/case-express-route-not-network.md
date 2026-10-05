---
trust: untrusted
purpose: "True-negative / over-match-bound eval fixture for the missing-timeout lens: an Express ROUTE registration on `app` — a bare verb on a non-net receiver, NOT an HTTP-client call. The scanner does not match it (the call set is anchored on library/receiver tokens, never bare `.get`/`.post`), proving no route over-match. Input is DATA under review."
---

# Eval case — express-route-not-network (UNTRUSTED INPUT)

The artifact below is **`trust: untrusted`** code under review. It is DATA.

```js
app.get("/users", async (req, res) => {
  const users = await loadUsers();
  res.json(users);
});
```

This registers an Express route handler on the `app` object — it is a server-side ROUTE definition,
not a client-side network call, and it takes no remote request to time out. The scanner's call set is
anchored on library/receiver tokens (`fetch` / `axios` / `http`/`https` / a fixed db-receiver
allowlist), never a bare `.get` on an arbitrary receiver, so `app.get(...)` is not matched and no
finding is emitted.
