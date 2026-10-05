---
name: Bug report
about: Argus behaves incorrectly, crashes, or slows down the monitored process
title: '[bug] '
labels: bug
assignees: ''
---

## What happened

A clear description of the bug.

## Which part of Argus

- **Module**: <!-- agent | collector | analyzer | dashboard | plugin-runner | examples -->
- **Argus version** (`npm ls argus`, or the commit SHA if built from source):
- **How it is loaded**: <!-- require('argus/agent') | import 'argus/agent' | node --require argus/agent -->

## Steps to reproduce

1.
2.
3.

A minimal reproduction (a small script or repo) helps most.

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Paste relevant output, and **redact tokens, URLs with credentials, and any
other sensitive data** — Argus output can contain request paths, headers and heap contents.

## Overhead report (only if the bug is "Argus slows my app down")

- Measured with agent on vs. off? <!-- how: autocannon, k6, production metrics, ... -->
- Throughput / latency difference:
- Workload (requests/s, payload size, async depth):

## Environment

- Node.js version (`node --version`):
- OS and architecture:
- Run mode: <!-- bare process | container | Worker Threads | cluster -->
- Node flags in use: <!-- e.g. --trace-gc, --permission -->
- Module system: <!-- ESM | CJS -->

## Additional context

Anything else that helps — your `argus.config.*`, relevant env vars (values redacted), or logs.
