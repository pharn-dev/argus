---
spec_id: phargus-serve-cli
spec_content_hash: 0c1f884c4ecd195fe4165072ffce115b9c3923058dc80ee2b497975f26519759
---

## Files

- `src/cli/phargus-serve-cli.ac1.integration.test.ts` — the tests for AC-1
- `src/cli/phargus-serve-cli.ac2.integration.test.ts` — the tests for AC-2
- `src/cli/phargus-serve-cli.ac3.integration.test.ts` — the tests for AC-3
- `src/cli/phargus-serve-cli.ac4.integration.test.ts` — the tests for AC-4
- `src/cli/phargus-serve-cli.ac5.integration.test.ts` — the tests for AC-5
- `src/cli/phargus-serve-cli.ac6.integration.test.ts` — the tests for AC-6
- `src/cli/phargus-serve-cli.ac7.integration.test.ts` — the tests for AC-7
- `src/cli/phargus-serve-cli.ac8.integration.test.ts` — the tests for AC-8
- `src/cli/phargus-serve-cli.ac9.integration.test.ts` — the tests for AC-9
- `src/cli/phargus-serve-cli.ac10.integration.test.ts` — the tests for AC-10

## Mapping

- AC-1 | integration | `src/cli/phargus-serve-cli.ac1.integration.test.ts` | command `node dist/esm/cli/bin.js --help` and `node dist/esm/cli/bin.js --version` (package.json bin "phargus"): exit code and stdout
- AC-2 | integration | `src/cli/phargus-serve-cli.ac2.integration.test.ts` | command `node dist/esm/cli/bin.js serve --bogus`, `serve --port abc`, `serve --port 70000`, `serve --window-ms 0`, `serve --max-line-bytes 0`: exit code and stderr
- AC-3 | integration | `src/cli/phargus-serve-cli.ac3.integration.test.ts` | command `node dist/esm/cli/bin.js serve --host 0.0.0.0 --port 0` (exit code, stderr); command `serve --port 0` with env PHARGUS_TOKEN, then route GET /events on the printed URL without and with `Authorization: Bearer <token>`
- AC-4 | integration | `src/cli/phargus-serve-cli.ac4.integration.test.ts` | command `node dist/esm/cli/bin.js serve --port 0 --window-ms 1000` fed on stdin; stderr URL, input-ended and `counts:` lines; route GET /events (SSE `window` events) before and after stdin ends
- AC-5 | integration | `src/cli/phargus-serve-cli.ac5.integration.test.ts` | app `node --import dist/esm/agent/auto.js <app>` piped into command `node dist/esm/cli/bin.js serve --port 0`; route GET /events (SSE `window` event)
- AC-6 | integration | `src/cli/phargus-serve-cli.ac6.integration.test.ts` | command `node dist/esm/cli/bin.js serve --port 0 <file>` and `serve --port 0 -`; route GET /events (SSE `window` event); missing path: exit code and stderr
- AC-7 | integration | `src/cli/phargus-serve-cli.ac7.integration.test.ts` | command `node dist/esm/cli/bin.js serve --port 0` with stdin held open and route GET /events connected; SIGTERM and SIGINT: exit code within 10 s, SSE response end, stderr `counts:` line
- AC-8 | integration | `src/cli/phargus-serve-cli.ac8.integration.test.ts` | command `node dist/esm/cli/bin.js serve --port <bound port>` without and with env PHARGUS_DEBUG=1: exit code and stderr
- AC-9 | integration | `src/cli/phargus-serve-cli.ac9.integration.test.ts` | command `npm pack --ignore-scripts` after the build: tarball `package/package.json` bin "phargus" and that entry's first line and file mode
- AC-10 | integration | `src/cli/phargus-serve-cli.ac10.integration.test.ts` | module `eslint` export `ESLint` with the repo's `eslint.config.mjs`: `lintText(source importing '../cli/serve.js', { filePath: 'src/agent/<probe>.ts' })` reports rule `no-restricted-imports`
