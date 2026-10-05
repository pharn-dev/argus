---
trust: trusted
purpose: "Expected output for case-axios-timeout-option: a call that passes an explicit timeout option reads CLEAN, so the lens emits NO finding — and a clean scan is not proof of reliable timeouts."
skill_kind: llm
---

# Expected — axios-timeout-option

The lens must emit **no** finding. `pharn/floor/scan-code-missing-timeout.mjs` reports `found:false`
because the call carries an explicit `timeout` option in its own argument object — the call-local
indicator test finds a timeout token and reports the call CLEAN.

- `finding_count == 0` is the whole structural assertion (`expected-axios-timeout-option.json`,
  `skill_kind: llm`).
- The lens must **not** manufacture a finding here. A clean scan means only that this call passes an
  in-args timeout indicator — it is **not** proof the code has reliable timeouts everywhere (the
  advisory bound: a timeout could still be missing on some other, non-matched client).
