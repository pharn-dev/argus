# REGRESSION — collector-foreign-records

base: `aad3a149e923b02fa1c22bd7b803bcdf64c5d437` — chosen by: named with --base

**verdict: NO REGRESSIONS** — no deterministically-detectable breakage outside the feature.

BASE evidence: produced by this invocation (not reused: `no-delivery-run`; entry evidence not used: `no-delivery-run`); not recorded for reuse (`no-delivery-run`).

install:

```text
npm ci
```

HEAD install: checked — npm's record of the installed tree agrees with `package-lock.json` (24 absent dev/peer/optional package(s) not counted). That `node_modules` holds those packages is not itself checked (install-drift-core.mjs).

## Scope

inside (26):

```text
ARCHITECTURE.md
CHANGELOG.md
FEATURES.md
README.md
docs/LIMITS.md
docs/THREAT-MODEL.md
examples/express-app/README.md
examples/express-app/app.mjs
examples/express-app/index.mjs
src/collector/collector.ts
src/collector/index.ts
pharn/features/collector-foreign-records/AC-TESTS.lock.json
pharn/features/collector-foreign-records/AC-TESTS.md
pharn/features/collector-foreign-records/BUILD.md
pharn/features/collector-foreign-records/GRILL.md
pharn/features/collector-foreign-records/LOOP.md
pharn/features/collector-foreign-records/PLAN.md
pharn/features/collector-foreign-records/SPEC.md
pharn/features/collector-foreign-records/VERIFY.md
pharn/features/collector-foreign-records/cost.json
pharn/features/collector-foreign-records/verify-report.json
src/collector/collector-foreign-records.ac1.test.ts
src/collector/collector-foreign-records.ac2.test.ts
src/collector/collector-foreign-records.ac3.integration.test.ts
src/collector/ndjson-decoder.ts
src/collector/record-guard.ts
```

declared (16):

```text
src/collector/record-guard.ts
src/collector/ndjson-decoder.ts
src/collector/collector.ts
src/collector/index.ts
README.md
examples/express-app/index.mjs
examples/express-app/app.mjs
examples/express-app/README.md
ARCHITECTURE.md
FEATURES.md
docs/LIMITS.md
docs/THREAT-MODEL.md
CHANGELOG.md
src/collector/collector-foreign-records.ac1.test.ts
src/collector/collector-foreign-records.ac2.test.ts
src/collector/collector-foreign-records.ac3.integration.test.ts
```

escape-exempt (10) — this feature's own pipeline artifacts or a hook-protected trusted doc, never a build escape:

```text
pharn/features/collector-foreign-records/AC-TESTS.lock.json
pharn/features/collector-foreign-records/AC-TESTS.md
pharn/features/collector-foreign-records/BUILD.md
pharn/features/collector-foreign-records/GRILL.md
pharn/features/collector-foreign-records/LOOP.md
pharn/features/collector-foreign-records/PLAN.md
pharn/features/collector-foreign-records/SPEC.md
pharn/features/collector-foreign-records/VERIFY.md
pharn/features/collector-foreign-records/cost.json
pharn/features/collector-foreign-records/verify-report.json
```

## Gates

gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): build
gate: base exit 1 -> head exit 1 — pre-existing (already red at base) — id (quoted, untrusted): test
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): typecheck

style gates were SKIPPED (config-touch rule: no shared style config changed in scope).

## Pre-existing and regressions

pre_existing (1): test
regressions (0): (none)

_/pharn-regress catches exactly what the project's own deterministic suite catches, nothing more — but deterministically. This is not a claim that nothing broke._
