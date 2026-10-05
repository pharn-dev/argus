# Argus — Threat Model

> **Status: pre-release.** Argus is being built (see [`ROADMAP.md`](../ROADMAP.md)). This document
> is the security design the code is held to. Each requirement below is marked **Enforced today**
> (a check in this repository fails if it is violated) or **Required by design** (must hold before
> the feature that needs it ships). It never claims that unbuilt code is secure. What Argus does
> _not_ guarantee is in [`LIMITS.md`](./LIMITS.md); how to report a problem is in
> [`SECURITY.md`](../SECURITY.md).

Argus runs **inside** the Node.js process it observes and serves what it sees to a browser. That
combination decides everything here: a flaw in Argus is a flaw in the host process, and anything
the dashboard shows is data an attacker would like.

## 1. Trust assumptions

- **Trusted:** the operator who installs and configures Argus, and the host application's own code.
  Argus does not defend the host from itself or from an operator who chooses to expose the dashboard.
- **Not trusted:** anything that reaches the dashboard over the network; **plugin rules** (user
  supplied code); **heap snapshots, profiles and stack traces** handed to the analyzer; the content
  of the host's requests (URLs, headers, payloads) that Argus records; and every dependency, build
  step and release artifact in the supply chain.
- **Out of scope:** an attacker who can already run code inside the host process (they can do
  anything Argus can), and physical access to the machine.

## 2. Surfaces, threats and mitigations

| #   | Surface                                        | Threat                                                                                          | Mitigation (what must be true)                                                                                                                                                                                                                                                                   | Status             |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| A1  | Agent in the host process                      | Argus crashes, stalls or leaks memory in production                                             | Every hook and timer catches its own errors and never throws into the host. All buffers are bounded (ring buffer). Slow consumers are dropped, never queued without limit, so a slow dashboard cannot slow the app. Overhead is benchmarked agent-on vs agent-off for hot-path changes.          | Required by design |
| A2  | Agent in the host process                      | A dependency of Argus compromises every host that loads it                                      | The agent imports only `node:` builtins and its own files, and the root package has no runtime `dependencies`. An ESLint rule on `src/agent/**` rejects any other import.                                                                                                                        | Enforced today     |
| B1  | Dashboard and SSE endpoint                     | Unauthenticated access to runtime internals                                                     | Binds to localhost by default. Binding anywhere else without a token is refused at startup. The token is compared in constant time.                                                                                                                                                              | Required by design |
| B2  | Dashboard and SSE endpoint                     | A web page the operator visits attacks the local dashboard (DNS rebinding, cross-site requests) | `Host` and `Origin` are checked against an allowlist; no wildcard CORS; state-changing actions (such as taking a heap snapshot) need the token and a non-simple request.                                                                                                                         | Required by design |
| B3  | Dashboard and SSE endpoint                     | The token leaks through URLs, logs or `Referer`                                                 | The token is exchanged once for an `HttpOnly`, `SameSite=Strict` cookie and is never kept in a URL that persists. It is never logged.                                                                                                                                                            | Required by design |
| B4  | Dashboard and SSE endpoint                     | Traffic read or altered on the network                                                          | Argus does not terminate TLS. Remote access goes through an authenticated tunnel or a reverse proxy; the docs say so. See `LIMITS.md`.                                                                                                                                                           | Documented limit   |
| C1  | Collected data (traces, URLs, headers)         | Secrets and personal data end up on the dashboard, on disk or in an alert                       | Capture is allowlist-based. `Authorization`, `Cookie`, `Set-Cookie` and query-string values are redacted by default. Redaction runs before data enters the ring buffer, so every sink sees the redacted form.                                                                                    | Required by design |
| C2  | Heap snapshots                                 | A snapshot contains whatever was in memory (keys, tokens, user data)                            | Snapshots are opt-in and taken only on an authenticated request. They are never exported automatically, never sent to an alert sink or to OpenTelemetry, and are written with mode `0600`.                                                                                                       | Required by design |
| D1  | Plugin runner                                  | A rule escapes its sandbox or reads host state                                                  | Rules run in `isolated-vm` with no host references and no `require`. They receive copies of aggregated data only. Rules load from an explicit local path, never from the network.                                                                                                                | Required by design |
| D2  | Plugin runner                                  | A rule exhausts memory or never returns                                                         | A hard memory limit and a timeout apply to every execution. A rule cannot raise them. A rule that exceeds either is terminated and disabled, and the failure is reported, not swallowed.                                                                                                         | Required by design |
| E1  | Analyzer (heap snapshots, stack symbolization) | A crafted snapshot or trace exhausts memory or CPU                                              | Parsing runs only in Worker Threads (never on the monitored event loop) with `resourceLimits`, an input size cap and a timeout. A worker that exceeds a limit is terminated and its failure surfaced. No `eval` and no inline workers.                                                           | Required by design |
| E2  | Analyzer                                       | Source-map or symbol lookup reads files it should not                                           | Lookups are confined to directories named in configuration. Paths are normalized and any that escape those directories are rejected.                                                                                                                                                             | Required by design |
| E3  | `--trace-gc` and `--trace-deopt` parsing       | Malformed or oversized lines break the parser                                                   | Lines are length-bounded and treated purely as data. Unparseable input is counted and dropped.                                                                                                                                                                                                   | Required by design |
| F1  | Persistence                                    | Path traversal, world-readable files, unbounded disk growth                                     | Opt-in only. The path comes from configuration, never from request data. Files are `0600` in a `0700` directory, append-only, with a size cap and rotation.                                                                                                                                      | Required by design |
| F2  | Alert webhooks and OpenTelemetry export        | Data leaves the process without the operator realizing, or a hung endpoint stalls the host      | Both are opt-in and off by default. The docs state exactly what each sends. Requests have timeouts and size caps, do not follow redirects, and use Node core `fetch`/`http` only (so the zero-dependency rule holds).                                                                            | Required by design |
| G1  | Supply chain and releases                      | A malicious or tampered release, workflow or dependency                                         | GitHub Actions are pinned to commit SHAs, and CI fails on an unpinned action. Releases publish through npm Trusted Publishing with provenance, from a job that installs nothing; the job that builds holds no publish rights. CodeQL and a pinned, checksum-verified gitleaks scan every change. | Enforced today     |

## 3. Named residual risks

These are accepted, not hidden:

1. **`isolated-vm` is defense in depth, not an absolute boundary.** It is a native addon over V8; a
   V8 or addon vulnerability could break isolation. Argus limits what a rule can reach and how much
   it can consume, and treats a rule as untrusted regardless.
2. **Redaction is a filter, not a proof.** An unusual header or a secret in a URL path can pass an
   allowlist. Operators handling sensitive data should extend the redaction rules.
3. **The agent shares a process with the host.** A fault in Argus is a fault in the application, and
   an attacker with code execution in the host can read or alter Argus's data.
4. **The token gate is access control, not transport security** (B4).
5. **Provenance shows where a package was built, not that its source is benign.** The publish
   pipeline narrows the window for tampering (the tarball is built in an unprivileged job) but a
   compromised dev dependency there could still alter the package contents.

## 4. Keeping this document honest

When a feature from the table ships, its tests must demonstrate the mitigation, and its status
changes to **Enforced today** in the same pull request. A new surface (a new network listener, a
new place data is written or sent, new parsing of untrusted input) needs a new row before it merges.
