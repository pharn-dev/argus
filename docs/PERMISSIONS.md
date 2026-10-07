# Running Argus under the Node permission model

Argus requires Node.js 22.18 or newer, where the permission model is enabled with `--permission`
(stable since Node 22.13, and on Node 24). The older `--experimental-permission` flag is not
supported by the agent.

Each module needs only the grants for what it does. The agent needs file system grants only; the
analyzer and the plugin runner also start threads or processes.

## Agent (`argus/agent`)

```bash
node --permission \
  --allow-fs-read=<app dir> \
  --allow-fs-read=<path to node_modules/argus> \
  --allow-fs-write=<NDJSON output file or its directory> \
  --allow-fs-write=<heap snapshot dir> \
  --require argus/agent app.js
```

| Grant                                  | Needed for                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `--allow-fs-read=<app dir>`            | Loading your app, and reading `argus.config.json` / `argus.config.js` from the cwd |
| `--allow-fs-read=<node_modules/argus>` | Loading the agent itself                                                           |
| `--allow-fs-write=<output path>`       | The NDJSON export to a file (`output` other than `'stdout'` or `'none'`)           |
| `--allow-fs-write=<snapshot dir>`      | `takeHeapSnapshot({ dir })`, which also needs `--allow-fs-read=<snapshot dir>`     |

`output: 'stdout'` needs no write grant. Leave out the write grants for features you do not use.

The agent spawns no worker threads and no child processes, so none of `--allow-worker`,
`--allow-child-process`, `--allow-addons` or `--allow-wasi` is needed for it.

## Analyzer (`argus/analyzer`)

Heap-snapshot summaries and diffs and stack-trace symbolization run in Worker Threads:

| Grant                                     | Needed for                                  |
| ----------------------------------------- | ------------------------------------------- |
| `--allow-worker`                          | Starting the worker pool                    |
| `--allow-fs-read=<node_modules/argus>`    | Loading the worker files                    |
| `--allow-fs-read=<snapshot or build dir>` | Reading the snapshots, built files and maps |

Analyzer workers inherit the host's flags, except entry-point and tooling flags such as
`--input-type`, `-e`, `-p`, `--test*`, `--watch*` and `--inspect*`, which are dropped.

## Plugin runner (`argus/plugin-runner`)

Rules run in `isolated-vm` inside a forked child process:

| Grant                                        | Needed for                                          |
| -------------------------------------------- | --------------------------------------------------- |
| `--allow-child-process`                      | Forking the sandbox process                         |
| `--allow-addons`                             | Loading `isolated-vm` (a native addon) in the child |
| `--allow-fs-read=<node_modules/argus>`       | Loading the sandbox child script                    |
| `--allow-fs-read=<node_modules/isolated-vm>` | Loading `isolated-vm`                               |
| `--allow-fs-read=<rules dir>`                | `loadRulesDirectory(dir)`                           |

The sandbox child is forked with `--no-node-snapshot` (which `isolated-vm` needs) plus every
`--permission`, `--experimental-permission` and `--allow-*` flag from the host's `execArgv`, so it
runs under the same permission model as the host. Without `--allow-addons`, every rule fails with
`ARGUS_ISOLATED_VM_MISSING`, and the host keeps running.

## Collector, dashboard and OpenTelemetry export

| Grant                                               | Needed for                          |
| --------------------------------------------------- | ----------------------------------- |
| `--allow-fs-read=<node_modules/argus>`              | Loading the modules                 |
| `--allow-fs-read` and `--allow-fs-write=<the file>` | Window persistence (`persist.path`) |
| `--allow-fs-write=<the file>`                       | The file alert sink                 |

Only the agent and plugin-runner grants are exercised by tests that run under `--permission`
(`permission-model.ac2/ac3` and `plugin-runner-caps.integration.test.ts`). The analyzer, collector
and dashboard rows follow from the files and threads each module uses.

## When a grant is missing

In the agent, a denied write disables only that feature, with a typed error that never crashes the
host:

- **NDJSON export:** the agent writes one `[argus] agent disabled: ...` line to stderr, starts no
  sampling, and your app keeps running.
- **Heap snapshot:** `takeHeapSnapshot` rejects with an `ArgusPermissionError`. Its `scope` and
  `resource` properties name the denied scope and the absolute path, and its message names the flag
  that would grant it. No file is written.

Use `isPermissionModelEnabled()` and `checkPermission(scope, path)` from `argus/agent` to check a
grant yourself. When the permission model is off, every check is allowed.
