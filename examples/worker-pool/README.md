# worker-pool example

Argus watching a process that uses Worker Threads. One `import 'argus/agent'` line turns the agent on;
the example then runs CPU-heavy tasks on their own threads, takes an on-demand heap snapshot, and
analyses it on the `argus/analyzer` worker pool so the main event loop is never blocked.

## Run it

From the repo root:

```bash
npm run build
node examples/worker-pool/index.mjs
```

The example has no `package.json` of its own: `argus/agent` and `argus/analyzer` resolve through the
root package's `exports`, so they need the build above.

## What you'll see

The example's own lines carry a `[worker-pool] ` prefix:

```text
[worker-pool] cpu tasks completed: 4
[worker-pool] heap snapshot: nodes=<count> totalSelfSize=<bytes>
[worker-pool] heap top: <name> count=<count> selfSize=<bytes>     (up to 5 lines)
[worker-pool] event loop ticks during analysis: <count>
[worker-pool] done
```

The interleaved JSON lines are the agent's NDJSON samples. Set `ARGUS_OUTPUT=none` to silence them,
or `ARGUS_OUTPUT=<file path>` to write them to a file instead.

The tick count shows the main thread kept running while the analyzer worker parsed the snapshot.
The process exits on its own with code 0; on any failure it prints `[worker-pool] failed: ...` to
stderr and exits with code 1.
