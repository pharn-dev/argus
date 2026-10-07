# Running the agent under the Node permission model

The agent works under `node --permission`. It needs only file system grants, and only for what you
turn on. The flag is `--permission` on Node 22.13 and later and on Node 24. The older
`--experimental-permission` flag is not supported.

## Minimal flag set

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
| `--allow-fs-write=<output path>`       | The NDJSON export to a file (`output` other than `'stdout'`)                       |
| `--allow-fs-write=<snapshot dir>`      | `takeHeapSnapshot({ dir })`, which also needs `--allow-fs-read=<snapshot dir>`     |

`output: 'stdout'` needs no write grant. Leave out the write grants for features you do not use.

## Not needed

The agent spawns no worker threads and no child processes, so none of `--allow-worker`,
`--allow-child-process`, `--allow-addons` or `--allow-wasi` is needed.

## When a grant is missing

A denied write disables only that feature, with a typed error that never crashes the host:

- **NDJSON export:** the agent writes one `[argus] agent disabled: ...` line to stderr, starts no
  sampling, and your app keeps running.
- **Heap snapshot:** `takeHeapSnapshot` rejects with an `ArgusPermissionError`. Its `scope` and
  `resource` properties name the denied scope and the absolute path, and its message names the flag
  that would grant it. No file is written.

Use `isPermissionModelEnabled()` and `checkPermission(scope, path)` from `argus/agent` to check a
grant yourself. When the permission model is off, every check is allowed.
