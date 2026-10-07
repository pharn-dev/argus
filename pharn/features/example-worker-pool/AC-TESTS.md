---
spec_id: example-worker-pool
spec_content_hash: c605d6eb8de99aeed66a62dc386a3a68cfa2fc974181285f3fc6773150c8de40
---

## Files

- `src/analyzer/example-worker-pool.ac1.integration.test.ts` — the tests for AC-1
- `src/analyzer/example-worker-pool.ac2.integration.test.ts` — the tests for AC-2
- `src/analyzer/example-worker-pool.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/analyzer/example-worker-pool.ac1.integration.test.ts` | CLI `node examples/worker-pool/index.mjs` run as a child process via node:child_process with process.execPath, cwd = repo root, env = process.env with every ARGUS_* variable removed, bounded timeout (e.g. 60 s), after a fresh dist is ensured in beforeAll (build with `node scripts/build.mjs` when dist/esm/agent/auto.js, dist/esm/analyzer/index.js or dist/esm/analyzer/workers/heap-snapshot.worker.js is missing or older than a non-test src/**/*.ts file, serialized across test files by an fs.mkdirSync lock directory under os.tmpdir()); observed: exit code 0, no signal, stderr does not contain `[argus] agent disabled`, stdout matches /^\[worker-pool\] cpu tasks completed: ([1-9]\d*)$/m
- AC-2 | integration | `src/analyzer/example-worker-pool.ac2.integration.test.ts` | CLI `node examples/worker-pool/index.mjs` run exactly as for AC-1 (same fresh-dist beforeAll, env and timeout); observed: exit code 0, stdout matches /^\[worker-pool\] heap snapshot: nodes=([1-9]\d*) totalSelfSize=([1-9]\d*)$/m, /^\[worker-pool\] heap top: (\S.*?) count=\d+ selfSize=\d+$/m at least once with a non-empty name, and /^\[worker-pool\] event loop ticks during analysis: (\d+)$/m with the captured count >= 1
- AC-3 | integration | `src/analyzer/example-worker-pool.ac3.integration.test.ts` | the files under examples/worker-pool/ read with node:fs (recursive listing, no build needed): every .mjs/.js/.cjs/.ts source file's module specifiers (static `import … from '…'`, side-effect `import '…'`, dynamic `import('…')`, `require('…')`) are either `node:` builtins or bare /^argus\/[a-z-]+$/ specifiers, at least one is `argus/agent`, and none is a relative or absolute path containing `src/` or `dist/`; `examples/worker-pool/README.md` exists and its text contains `npm run build` and `node examples/worker-pool/index.mjs`
