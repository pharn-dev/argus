---
trust: trusted
purpose: "Expected output for case-db-query-with-timeout: a db call that passes a timeout token in its args reads CLEAN (the db branch respects the indicator). The API shape is illustrative — the indicator token is what the floor tests, not an endorsed driver API."
skill_kind: llm
---

# Expected — db-query-with-timeout

The lens must emit **no** finding. `pharn/floor/scan-code-missing-timeout.mjs` reports `found:false`
because the `db.query(...)` call passes a `timeout` token in its own argument object — the call-local
indicator test finds it and reports the call CLEAN.

- `finding_count == 0` is the whole structural assertion (`expected-db-query-with-timeout.json`,
  `skill_kind: llm`).
- This is the db **precision bound**: it proves the db branch respects the in-args indicator rather
  than naively flagging every `.query(`.
- **The exact API shape is illustrative.** Real node-postgres has no per-query `timeout` arg (its
  timeout is `query_timeout` at the Client, or `statement_timeout` via SQL/pool). This fixture is not
  endorsing a driver's option contract — it is only testing that an in-args timeout **indicator token**
  suppresses the db-branch hit. The lens must not manufacture a finding here.
