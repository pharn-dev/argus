---
spec_id: agent-config
state: Approved
spec_content_hash: b62ddaedd1c83680c9c5120e7e8bd791a84cda3c03683263df20f589383bbdbb
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S1 (agent core), third slice: configuration (FEATURES.md §1, "Config via env vars +
`argus.config.{js,json}`"). The agent already has samplers and an NDJSON exporter, but every setting is
passed by hand in code. A developer dropping the agent into a process needs to configure it without code
changes: through a config file in the project directory or through `ARGUS_` environment variables, with
env winning over the file and the file winning over built-in defaults. Because Argus is reached for when
something is already broken, a wrong setting must fail loudly and say exactly which source and key is
wrong, never quietly fall back to a default. This slice gives the agent one loader that produces a fully
resolved, validated, immutable config the later `--require` entry slice can consume.

## Scope

**In scope:**

- A config loader exported from `src/agent/index.ts` that takes a working directory and an environment
  object and returns a fully resolved, frozen config with at least: sampling interval in milliseconds,
  output destination (`stdout`, a file path, or disabled/none), exporter queue bound, and an `enabled`
  switch.
- Sources, lowest to highest precedence: built-in defaults, then `argus.config.json` or
  `argus.config.js` found in the given working directory (JSON parsed; a `.js` file loaded as a module
  exporting the config object through CommonJS `module.exports` or an ESM default export), then
  environment variables prefixed `ARGUS_` (`ARGUS_INTERVAL_MS`, `ARGUS_OUTPUT`, `ARGUS_QUEUE_BOUND`,
  `ARGUS_ENABLED`).
- Validation of every value from every source: integers must be positive integers within sane bounds,
  booleans from env strings accept `true`/`false`/`1`/`0`; an invalid value, an unparseable config file,
  an unknown key, or both config files present raises an error naming the source and the key (or both
  files), with no silent fallback.
- Node core only, with vitest tests using temporary directories.

**Out of scope (non-goals):**

- The `require('argus/agent')` / `--require` entry point that consumes this config.
- Wiring the config into the sampler controller or exporter (starting, stopping, opening the output file).
- Config keys beyond interval, output, queue bound and enabled (dashboard token, alert thresholds, GC,
  persistence).
- Searching parent directories for a config file, or a CLI flag / env var that points at a config path.
- Reloading config while the process runs.

## Acceptance Criteria

- **AC-1** Given a temporary directory containing an `argus.config.json` that sets the interval and the
  output to an absolute file path, and an environment object that sets `ARGUS_INTERVAL_MS` to a
  different valid integer and `ARGUS_ENABLED` to `"0"` When the loader exported from the agent
  entrypoint is called with that directory and that environment Then the returned config has the
  interval from the environment, the output equal to that file path from the JSON file, `enabled` equal
  to `false`, the queue bound equal to the built-in default, and `Object.isFrozen` of the config is true
  - verify: integration
- **AC-2** Given one temporary directory whose `argus.config.js` is a CommonJS module assigning a config
  object to `module.exports`, and another whose `argus.config.js` is an ES module with a default export
  of a config object, each with an empty environment When the loader is called on each directory Then
  each returned config carries the interval, queue bound and output values that its file exported
  - verify: integration
- **AC-3** Given separate temporary directories and environments for each of these setups: an
  `argus.config.json` that is not valid JSON; an `argus.config.json` with an unknown key `foo`; an
  `argus.config.json` setting the queue bound to `0`; `ARGUS_INTERVAL_MS` set to `"abc"`;
  `ARGUS_ENABLED` set to `"yes"`; and a directory holding both `argus.config.json` and
  `argus.config.js` When the loader is called for each setup Then every call fails with an error, and
  each error message contains the name of the offending source (the config file name, or the env
  variable name) together with the offending key where one applies, and the both-files error message
  contains both `argus.config.json` and `argus.config.js`
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party and zero workspace dependencies.
- No silent failures: every invalid value, unreadable or unparseable file, unknown key and duplicate
  config file is surfaced as an error; nothing falls back to a default once a source sets a key.
- No `async_hooks` import in this slice.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these integration criteria, with per-test
  results already configured; the test stage's preflight decides whether that holds.
- The loader may be asynchronous (loading an ESM config file needs dynamic `import()`); "called" in the
  criteria means called and awaited, and "fails" means the call throws or the returned promise rejects.
- Config file keys are `intervalMs`, `output`, `queueBound` and `enabled`, mirroring the env names; the
  exact exported function and key names are a PLAN choice, provided the env names stay as listed.
- Default values (interval, queue bound, output, `enabled: true`) and the numeric upper bounds for
  interval and queue bound are PLAN choices; the criteria only use values that are clearly valid or
  clearly invalid.
- `ARGUS_OUTPUT` accepts `stdout`, `none` (disabled) or a file path; how a relative path resolves (against
  the given working directory or kept as given) is a PLAN choice; the criteria use absolute paths.
- Whether a `.js` config file is CommonJS or ESM is decided by Node's own module rules (nearest
  `package.json` `type`); the CommonJS case in AC-2 is set up so Node treats the file as CommonJS.
- "Unknown keys are rejected" applies to config file keys; an unknown `ARGUS_`-prefixed environment
  variable is also rejected, naming that variable. Environment variables without the `ARGUS_` prefix are
  ignored.
- No config file in the working directory is not an error: defaults and env apply.
- An empty-string env value is treated as invalid for its key, not as unset.
