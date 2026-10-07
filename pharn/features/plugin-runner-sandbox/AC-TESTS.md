---
spec_id: plugin-runner-sandbox
spec_content_hash: 76472e01a4855b1dd01f7431f05eb385416f2c8115d1f75f35fe5c43e409e83d
---

## Files

- `src/plugin-runner/plugin-runner-sandbox.ac1.integration.test.ts` — the tests for AC-1
- `src/plugin-runner/plugin-runner-sandbox.ac2.integration.test.ts` — the tests for AC-2
- `src/plugin-runner/plugin-runner-sandbox.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/plugin-runner/plugin-runner-sandbox.ac1.integration.test.ts` | src/plugin-runner/index.ts#createPluginRunner(options?: { timeoutMs?: number; memoryLimitMb?: number; isolatedVmModule?: string }): PluginRunner — PluginRunner = { run(source: string, windows: readonly AggregatedWindow[]): Promise<RuleRunResult>; close(): Promise<void> }; RuleRunResult = { ok: true; findings: { windowStart: number; message: string }[] } | { ok: false; error: { code: string; message: string } }; rule source is a function body receiving `windows` and returning findings; run against three AggregatedWindow values (distinct `start`, eventLoop.max 50, 500, 50); observed: ok true, exactly one finding with windowStart equal to the second window's start, result deep-equals JSON.parse(JSON.stringify(result)); close() in afterAll
- AC-2 | integration | `src/plugin-runner/plugin-runner-sandbox.ac2.integration.test.ts` | src/plugin-runner/index.ts#createPluginRunner({ timeoutMs: 200, memoryLimitMb: 16 }) and RuleErrorCode (RULE_THREW, TIMEOUT, MEMORY_LIMIT, COMPILE_ERROR) — sequential runs of `throw new Error('boom')`, `while (true) {}`, an unbounded-allocation loop, and invalid JavaScript, each resolving (never rejecting) { ok: false, error.code } with the matching RuleErrorCode value and `boom` in the RULE_THREW message; the infinite-loop run resolves within 2000ms while a host setInterval(10ms) counter keeps increasing during it; a fifth run of the AC-1 rule on the same runner resolves ok true; close() in afterAll
- AC-3 | integration | `src/plugin-runner/plugin-runner-sandbox.ac3.integration.test.ts` | src/plugin-runner/index.ts#createPluginRunner({ isolatedVmModule: '<a specifier that does not resolve>' }) and RuleErrorCode.ISOLATED_VM_MISSING — run(source, windows) resolves (never rejects) { ok: false, error: { code: RuleErrorCode.ISOLATED_VM_MISSING, message } } whose message contains `isolated-vm` and `npm install isolated-vm`; the test process is still running afterwards (a later assertion executes, process.exitCode unset); close() resolves
