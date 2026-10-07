---
spec_id: agent-permission-model
spec_content_hash: 529e2e6294f821961c22f5ebaafac10898d1070e5b84133b1425849df25a47b5
---

## Files

- `src/agent/permission-model.ac1.test.ts` — the tests for AC-1
- `src/agent/permission-model.ac2.integration.test.ts` — the tests for AC-2
- `src/agent/permission-model.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/permission-model.ac1.test.ts` | src/agent/index.ts#isPermissionModelEnabled(): boolean; src/agent/index.ts#checkPermission(scope: 'fs.read' | 'fs.write', reference: string): { allowed: boolean; scope: string; resource: string }; src/agent/index.ts#ArgusPermissionError — class extends Error, constructor(scope: string, resource: string), readonly scope: string, readonly resource: string — driven in-process (vitest, imported from ./index.js): called once with process.permission as the runtime has it (undefined without --permission) and a relative path, expecting false and allowed: true; then with process.permission stubbed (Object.defineProperty, restored after) to an object whose has(scope, reference) records its arguments and returns false, expecting true, has called with 'fs.write' and path.resolve(<relative path>), and allowed: false; and new ArgusPermissionError('fs.write', '/abs/x') is an Error with scope 'fs.write' and resource '/abs/x'
- AC-2 | integration | `src/agent/permission-model.ac2.integration.test.ts` | argus/agent NDJSON file export (src/agent/agent-output.ts#openAgentOutput via src/agent/auto-start.ts) — a child `node --permission --allow-fs-read=<temp package root> [--allow-fs-write=<out dir>] --require argus/agent app.cjs` spawned with process.execPath in a temp package compiled from src/agent by tsc (the agent-entry pattern, realpathSync'd temp root), env ARGUS_OUTPUT=<out dir>/out.ndjson and a short ARGUS_INTERVAL_MS, the app printing a marker on stdout and running briefly; with the write grant: the output file exists with at least one JSON-parsable line and stderr has no `[argus] agent disabled` line; without it: no output file, exactly one stderr line starting `[argus] agent disabled:`, the marker on stdout, exit code 0
- AC-3 | integration | `src/agent/permission-model.ac3.integration.test.ts` | argus/agent#takeHeapSnapshot(options: { dir: string }): Promise<{ path: string; bytes: number }> and argus/agent#ArgusPermissionError — a child `node --permission --allow-fs-read=<temp package root> [--allow-fs-write=<snapshot dir>] app.cjs` spawned with process.execPath in the same kind of temp package (snapshot dir an existing subdirectory of the realpathSync'd root, env ARGUS_OUTPUT=none), the app calling takeHeapSnapshot({ dir }) and printing { ok, path } or { ok: false, isPermissionError, name, scope, resource } as JSON on stdout; with the write grant: ok, path inside dir, ends in `.heapsnapshot`, exists; without it: isPermissionError true, scope 'fs.write', resource an absolute path inside dir, no `.heapsnapshot` file in dir, exit code 0
