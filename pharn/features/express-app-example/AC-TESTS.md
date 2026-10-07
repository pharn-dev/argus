---
spec_id: express-app-example
spec_content_hash: 470881cda3f5079bb539e8a36521b59e9bf62fe3c0e7827ee00d51a8b23a3235
---

## Files

- `src/dashboard/example-express-app.ac1.integration.test.ts` — the tests for AC-1
- `src/dashboard/example-express-app.ac2.integration.test.ts` — the tests for AC-2
- `src/dashboard/example-express-app.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/dashboard/example-express-app.ac1.integration.test.ts` | CLI `node examples/express-app/index.mjs` spawned via node:child_process with process.execPath, cwd = repo root, env = process.env with every ARGUS_* variable removed plus APP_PORT=0 and DASHBOARD_PORT=0, after a fresh dist is ensured in beforeAll (build with `node scripts/build.mjs` when dist/esm/agent/auto.js, dist/esm/collector/index.js or dist/esm/dashboard/index.js is missing or older than a non-test src/**/*.ts file, serialized by an fs.mkdirSync lock directory under os.tmpdir() as the worker-pool example tests do); ports read from stdout lines /^\[express-app\] app listening on http:\/\/127\.0\.0\.1:(\d+)$/m and /^\[express-app\] dashboard listening on http:\/\/127\.0\.0\.1:(\d+)$/m; routes GET http://127.0.0.1:<app>/fast, GET /slow, GET /error; observed: statuses 200, 200, 500, and GET http://127.0.0.1:<dashboard>/events (text/event-stream) delivers, within a bounded timeout, `span` events whose JSON data have name `GET /fast` / `GET /slow` / `GET /error` and statusCode 200 / 200 / 500, one each; the child is sent SIGTERM in afterAll
- AC-2 | integration | `src/dashboard/example-express-app.ac2.integration.test.ts` | the same CLI run, env, ports and SSE connection as AC-1; route GET http://127.0.0.1:<app>/slow; observed: within a bounded timeout GET http://127.0.0.1:<dashboard>/events delivers a `window` event whose JSON data has eventLoop.max >= 50000000 and an `end` at or after the time the /slow request was sent; the child is sent SIGTERM in afterAll
- AC-3 | integration | `src/dashboard/example-express-app.ac3.integration.test.ts` | the same CLI run as AC-1, then process signal SIGTERM to the child; observed: exit code 0 with no signal within a bounded timeout and stderr not containing `[argus] agent disabled`; plus the files under examples/express-app/ read with node:fs: every .mjs/.js/.cjs/.ts source file's module specifiers (static import, side-effect import, dynamic import(), require()) are `node:` builtins or bare /^argus\/[a-z-]+$/ specifiers, none contains `src/` or `dist/`, none is `express` or starts with `express/`, and examples/express-app/README.md contains `npm run build`, `node examples/express-app/index.mjs` and `Express`
