---
spec_id: agent-entry
spec_content_hash: f9fb4eb821cf3236522db36cfc728ad3330b322e01616d51e01c36837931e91e
---

## Files

- `src/agent/agent-entry.ac1.integration.test.ts` — the tests for AC-1
- `src/agent/agent-entry.ac2.integration.test.ts` — the tests for AC-2
- `src/agent/agent-entry.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/agent/agent-entry.ac1.integration.test.ts` | package.json `exports["./agent"]` (`import` and `require` conditions) loaded as a preload — child `process.execPath --require argus/agent app` and `process.execPath --import argus/agent app`, with cwd a temp package (`name: "argus"`, the real package.json `exports` copied verbatim, every non-test `src/agent/*.ts` compiled with the installed typescript to `dist/esm/agent` and `dist/cjs/agent`) and env `ARGUS_OUTPUT=<temp file>` + `ARGUS_INTERVAL_MS=<short>`, plus one `--require` run with `ARGUS_OUTPUT=stdout`; observed via exit code, stderr, the output file's NDJSON lines (integer `timestamp`, `eventLoop`, `memory`, `gc`, `backpressure`) and stdout
- AC-2 | integration | `src/agent/agent-entry.ac2.integration.test.ts` | package.json `exports["./agent"]` in a child `process.execPath --require argus/agent app.cjs` (same temp package build as AC-1) whose app also calls `require('argus/agent')` twice and `import('argus/agent')` once and prints `typeof` of `loadAgentConfig`, `createSamplerController`, `createNdjsonExporter` on both module objects; run with `ARGUS_OUTPUT=<temp file>` + `ARGUS_INTERVAL_MS=<short>`, and again with `ARGUS_ENABLED=0`; observed via exit code, stdout and the output file's sample timestamps
- AC-3 | integration | `src/agent/agent-entry.ac3.integration.test.ts` | package.json `exports["./agent"]` as a `--require` and an `--import` preload (same temp package build as AC-1) of an app that prints `app ran` and exits, run with `ARGUS_INTERVAL_MS=abc` and with `ARGUS_OUTPUT=<path inside a missing directory>`; observed via exit code, stdout, and stderr (exactly one line starting `[argus]`, no `UnhandledPromiseRejection`, no stack trace)
