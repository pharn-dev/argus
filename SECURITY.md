# Security Policy

Argus runs **inside** the Node.js process it observes, and its dashboard exposes runtime internals
(request paths, timings, memory, and optionally heap snapshots). Both facts make security part of
the product, not an afterthought. We welcome coordinated disclosure of any vulnerability in this
repository.

> **Status:** Argus is pre-release. Roadmap steps S0 to S7 are implemented on `main`, but no version
> has been published yet, so there is nothing to patch in the wild today. Reports against `main` are
> welcome and are handled the same way.

## What Argus is, and its security surface

Argus is a single npm package with six subpath exports (`argus/agent`, `argus/collector`,
`argus/analyzer`, `argus/dashboard`, `argus/plugin-runner`, `argus/otel`). Its security-relevant
surface is:

- **The dashboard and SSE endpoint** — an HTTP server in whichever process you start it in (the
  monitored process or a separate collector process). Binding it anywhere but loopback requires a
  token; every request's `Host` is checked against an allowlist, and a cross-origin `Origin` on
  `/events` is refused.
- **Data Argus collects** — request method, path (query string removed), status and timing, runtime
  samples and, on demand, heap snapshots, which can contain secrets and personal data. What is
  captured and what leaves the process are part of the surface.
- **The plugin runner** — user-supplied rules executed in `isolated-vm` with a memory limit and a
  timeout.
- **The analyzer** — heap-snapshot and stack-trace parsing in Worker Threads. Both are untrusted
  structured input.
- **Persistence and export** — the opt-in on-disk store, alert webhooks, and the opt-in
  OpenTelemetry adapter.
- **Release integrity** — the supply chain of what you install. The agent (`src/agent`) has **zero**
  runtime dependencies by design, which also keeps its supply-chain exposure to Node core.

The security design and its named residual risks are in
[`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md); what Argus does not guarantee is in
[`docs/LIMITS.md`](./docs/LIMITS.md).

## Supported versions

Until 1.0, only the **latest** release (and `main`) receives security fixes.

| Version  | Supported          |
| -------- | ------------------ |
| Latest   | :white_check_mark: |
| < Latest | :x:                |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull
requests.**

Report privately through
[GitHub private vulnerability reporting](https://github.com/pharn-dev/argus/security/advisories/new).
The report stays confidential and embargoed until a fix ships.

Please include as much of the following as you can — it speeds up triage:

- The type of issue (e.g. authentication bypass, path traversal, sandbox escape, information
  disclosure, denial of service, supply-chain).
- The module and source file(s) involved.
- The affected version, tag, branch or commit.
- Step-by-step reproduction instructions and a proof of concept, if you have one.
- The impact: how an attacker might exploit the issue, and what they would gain.

## Response timeline

- **Initial acknowledgement** — within 3 business days of your report.
- **Preliminary assessment and severity** — within 7 days.
- **Resolution target** — critical issues within 30 days; other issues within 90 days.

We will keep you informed, coordinate disclosure timing with you, and credit you in the advisory
unless you ask to remain anonymous.

## Scope

### In scope

- **Dashboard / SSE access control** — authentication or token-check bypass, token leakage, missing
  or bypassable Host/Origin protections (e.g. DNS rebinding), or unintended exposure when not bound
  to localhost.
- **Data exposure** — secrets, credentials or personal data reaching the dashboard, logs, disk, an
  alert sink or an export beyond what the threat model says is captured; heap snapshots produced or
  exposed without an explicit opt-in.
- **Plugin sandbox** — escaping `isolated-vm`, or bypassing the memory limit or timeout enforced by
  the plugin runner, from a user-supplied rule.
- **Analyzer input handling** — a crafted heap snapshot, profile or stack trace that crashes the
  host process, exhausts memory beyond the documented caps, or executes code.
- **Agent safety** — anything that lets the agent be used to attack, crash or measurably degrade the
  host process it runs in, including unbounded memory growth from collected data.
- **Persistence and export** — path traversal, unsafe file permissions, or injection through the
  on-disk store, NDJSON export, alert webhooks or the OpenTelemetry adapter.
- **Release and supply-chain integrity** — a way to publish, alter or substitute a release artifact,
  or to introduce a runtime dependency into the agent unnoticed.

### Out of scope

- Vulnerabilities in third-party dependencies that are fixed by an upstream patch — including
  `isolated-vm` itself. Please report those to the upstream project (and feel free to tell us so we
  can bump our floor).
- Issues that require the attacker to already control the monitored process, or have local code
  execution as the same user.
- Exposing a loopback-bound, token-less dashboard to other people through your own tunnel or
  proxy.
- Social engineering, or attacks requiring physical access to a machine.
- Denial of service that does not exploit a specific vulnerability (e.g. simply sending a very high
  request rate).

## Security best practices for users

1. **Keep the dashboard on localhost** and reach it through an authenticated tunnel (such as SSH
   port-forwarding) in production. Binding elsewhere requires a token; use a long random one, and
   list the names you reach it by in `allowedHosts`.
2. **Treat heap snapshots as secrets.** They contain whatever was in memory.
3. **Review plugin rules** before loading them, and keep the sandbox limits enabled.
4. **Confine the symbolizer** with the `roots` option when stack frames may name files outside your
   own build.
5. **Pin and verify.** Install exact versions and verify package provenance where it is available.
6. **Run with the Node Permission Model** (`--permission`) where your deployment allows it.

## Acknowledgements

We appreciate the security research community. Anyone who reports a valid issue in good faith will
be credited in the resulting advisory, unless they ask to remain anonymous.

Thank you for helping keep Argus and its users safe.
