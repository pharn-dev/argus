# REGRESSION — phargus-serve-cli

base: `d697b7a02f27d9c502cc141d40f1c77ffc7747ef` — chosen by: named with --base

**verdict: NO REGRESSIONS** — no deterministically-detectable breakage outside the feature.

BASE evidence: taken from this run's ENTRY gates — the run marker, the entry offer, the pre-run snapshot, the entry stamp (sha256 `5b625946c8d8740aadfe65d3b0f955021ba0c7088df166208107958a24a3117a`) and its logs agree with this invocation's BASE slots at `d697b7a02f27d9c502cc141d40f1c77ffc7747ef`, so this invocation created no base worktree, ran no install and spawned no base gate (retained evidence not reused: `no-record`). The base stamp marks every slot `reused` from the entry run (`test`, `lint`, `format:check`, `typecheck`, `build`). That they equal what a fresh BASE worktree would give is NOT claimed: the entry gates ran in this tree's real start environment.

install: none run by this invocation (the BASE evidence came from this run's entry gates).

HEAD install: checked — npm's record of the installed tree agrees with `package-lock.json` (24 absent dev/peer/optional package(s) not counted). That `node_modules` holds those packages is not itself checked (install-drift-core.mjs).

## Scope

inside (39):

```text
ARCHITECTURE.md
CHANGELOG.md
FEATURES.md
README.md
docs/THREAT-MODEL.md
eslint.config.mjs
examples/express-app/README.md
examples/express-app/app.mjs
package.json
scripts/build.mjs
scripts/check-exports.mjs
scripts/check-install.mjs
scripts/check-package.mts
src/dashboard/index.ts
tsconfig.cjs.json
pharn/features/phargus-serve-cli/AC-TESTS.lock.json
pharn/features/phargus-serve-cli/AC-TESTS.md
pharn/features/phargus-serve-cli/BUILD.md
pharn/features/phargus-serve-cli/GRILL.md
pharn/features/phargus-serve-cli/PLAN.md
pharn/features/phargus-serve-cli/SPEC.md
src/cli/args.ts
src/cli/bin.ts
src/cli/input.ts
src/cli/main.ts
src/cli/phargus-serve-cli.ac1.integration.test.ts
src/cli/phargus-serve-cli.ac10.integration.test.ts
src/cli/phargus-serve-cli.ac2.integration.test.ts
src/cli/phargus-serve-cli.ac3.integration.test.ts
src/cli/phargus-serve-cli.ac4.integration.test.ts
src/cli/phargus-serve-cli.ac5.integration.test.ts
src/cli/phargus-serve-cli.ac6.integration.test.ts
src/cli/phargus-serve-cli.ac7.integration.test.ts
src/cli/phargus-serve-cli.ac8.integration.test.ts
src/cli/phargus-serve-cli.ac9.integration.test.ts
src/cli/report.ts
src/cli/serve.ts
src/cli/usage.ts
src/cli/version.ts
```

declared (33):

```text
src/cli/bin.ts
src/cli/main.ts
src/cli/args.ts
src/cli/usage.ts
src/cli/version.ts
src/cli/report.ts
src/cli/input.ts
src/cli/serve.ts
src/dashboard/index.ts
tsconfig.cjs.json
package.json
scripts/build.mjs
scripts/check-exports.mjs
scripts/check-package.mts
scripts/check-install.mjs
eslint.config.mjs
examples/express-app/app.mjs
examples/express-app/README.md
README.md
FEATURES.md
ARCHITECTURE.md
docs/THREAT-MODEL.md
CHANGELOG.md
src/cli/phargus-serve-cli.ac1.integration.test.ts
src/cli/phargus-serve-cli.ac2.integration.test.ts
src/cli/phargus-serve-cli.ac3.integration.test.ts
src/cli/phargus-serve-cli.ac4.integration.test.ts
src/cli/phargus-serve-cli.ac5.integration.test.ts
src/cli/phargus-serve-cli.ac6.integration.test.ts
src/cli/phargus-serve-cli.ac7.integration.test.ts
src/cli/phargus-serve-cli.ac8.integration.test.ts
src/cli/phargus-serve-cli.ac9.integration.test.ts
src/cli/phargus-serve-cli.ac10.integration.test.ts
```

escape-exempt (6) — this feature's own pipeline artifacts or a hook-protected trusted doc, never a build escape:

```text
pharn/features/phargus-serve-cli/AC-TESTS.lock.json
pharn/features/phargus-serve-cli/AC-TESTS.md
pharn/features/phargus-serve-cli/BUILD.md
pharn/features/phargus-serve-cli/GRILL.md
pharn/features/phargus-serve-cli/PLAN.md
pharn/features/phargus-serve-cli/SPEC.md
```

pre-run snapshot: applied — no undeclared path was already changed when this run began.

## Gates

gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): build
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): format:check
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): lint
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): test
gate: base exit 0 -> head exit 0 — ok — id (quoted, untrusted): typecheck

## Pre-existing and regressions

pre_existing (0): (none)
regressions (0): (none)

_/pharn-regress catches exactly what the project's own deterministic suite catches, nothing more — but deterministically. This is not a claim that nothing broke._
