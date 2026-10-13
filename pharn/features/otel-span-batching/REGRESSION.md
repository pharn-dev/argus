# REGRESSION — otel-span-batching

base: `aad3a149e923b02fa1c22bd7b803bcdf64c5d437` — chosen by: named with --base

**verdict: 1 REGRESSION(S) OUTSIDE THE FEATURE — STAGE FAILS.**

BASE evidence: REUSED — the run marker, the reuse record, the stamp and its logs agree with this invocation's BASE requirement (sha256 `03e49477d4dd0743787da80d57cd9ca6794127e809ff9bbe395850053d8d5ad2`; that an earlier /pharn-regress of this run produced them is advisory), so this invocation created no base worktree, ran no install and ran no base gate; `gate_run.base.stamp_sha256` in regression-report.json names the stamp.

install: none run by this invocation (the BASE evidence was reused).

HEAD install: checked — npm's record of the installed tree agrees with `package-lock.json` (24 absent dev/peer/optional package(s) not counted). That `node_modules` holds those packages is not itself checked (install-drift-core.mjs).

## Scope

inside (31):

```text
CHANGELOG.md
FEATURES.md
README.md
docs/THREAT-MODEL.md
src/otel/otel-metrics-export.ac3.integration.test.ts
src/otel/otel-trace-export.ac3.integration.test.ts
src/otel/otlp-batch-queue.ts
src/otel/otlp-bounds.integration.test.ts
src/otel/otlp-exporter-options.ts
src/otel/otlp-exporter.ts
src/otel/otlp-trace-exporter.ts
pharn/features/otel-span-batching/AC-TESTS.lock.json
pharn/features/otel-span-batching/AC-TESTS.md
pharn/features/otel-span-batching/BUILD.md
pharn/features/otel-span-batching/GRILL.md
pharn/features/otel-span-batching/PLAN.md
pharn/features/otel-span-batching/SPEC.md
pharn/features/otel-span-batching/VERIFY.md
pharn/features/otel-span-batching/verify-report.json
src/otel/otel-span-batching.ac1.integration.test.ts
src/otel/otel-span-batching.ac10.test.ts
src/otel/otel-span-batching.ac2.integration.test.ts
src/otel/otel-span-batching.ac3.integration.test.ts
src/otel/otel-span-batching.ac4.integration.test.ts
src/otel/otel-span-batching.ac5.integration.test.ts
src/otel/otel-span-batching.ac6.integration.test.ts
src/otel/otel-span-batching.ac7.integration.test.ts
src/otel/otel-span-batching.ac8.integration.test.ts
src/otel/otel-span-batching.ac9.integration.test.ts
src/otel/otlp-drop-reporter.ts
src/otel/otlp-pending-items.ts
```

declared (23):

```text
src/otel/otlp-pending-items.ts
src/otel/otlp-drop-reporter.ts
src/otel/otlp-batch-queue.ts
src/otel/otlp-exporter-options.ts
src/otel/otlp-trace-exporter.ts
src/otel/otlp-exporter.ts
src/otel/otlp-bounds.integration.test.ts
src/otel/otel-trace-export.ac3.integration.test.ts
src/otel/otel-metrics-export.ac3.integration.test.ts
docs/THREAT-MODEL.md
FEATURES.md
README.md
CHANGELOG.md
src/otel/otel-span-batching.ac1.integration.test.ts
src/otel/otel-span-batching.ac2.integration.test.ts
src/otel/otel-span-batching.ac3.integration.test.ts
src/otel/otel-span-batching.ac4.integration.test.ts
src/otel/otel-span-batching.ac5.integration.test.ts
src/otel/otel-span-batching.ac6.integration.test.ts
src/otel/otel-span-batching.ac7.integration.test.ts
src/otel/otel-span-batching.ac8.integration.test.ts
src/otel/otel-span-batching.ac9.integration.test.ts
src/otel/otel-span-batching.ac10.test.ts
```

escape-exempt (8) — this feature's own pipeline artifacts or a hook-protected trusted doc, never a build escape:

```text
pharn/features/otel-span-batching/AC-TESTS.lock.json
pharn/features/otel-span-batching/AC-TESTS.md
pharn/features/otel-span-batching/BUILD.md
pharn/features/otel-span-batching/GRILL.md
pharn/features/otel-span-batching/PLAN.md
pharn/features/otel-span-batching/SPEC.md
pharn/features/otel-span-batching/VERIFY.md
pharn/features/otel-span-batching/verify-report.json
```

pre-run snapshot: applied — no undeclared path was already changed when this run began.

## Gates

gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): build
gate: base exit 0 -> head exit 1 — REGRESSION — id (quoted, untrusted): test
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): typecheck

style gates were SKIPPED (config-touch rule: no shared style config changed in scope).

## Pre-existing and regressions

pre_existing (0): (none)
regressions (1): test

_/pharn-regress catches exactly what the project's own deterministic suite catches, nothing more — but deterministically. This is not a claim that nothing broke._
