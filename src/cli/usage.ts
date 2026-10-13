/** The `--help` text. Flag defaults here mirror the constants in `args.ts` and `serve.ts`. */
export const USAGE = `phargus: a live dashboard for the NDJSON the Phargus agent writes.

Usage:
  phargus serve [options] [file|-]
  phargus --help
  phargus --version

Quick start (two commands, nothing else to install):
  node --import @pharn-dev/phargus/agent app.mjs | npx phargus serve
  open the dashboard URL that phargus prints on stderr

Reads agent NDJSON from stdin (or "-"), or replays a file, aggregates it into windows and
serves the dashboard and its /events stream. Lines that are not agent records are skipped
and counted. The server keeps running after the input ends; stop it with Ctrl-C.

Options:
  --port <n>             Port to listen on, 0 to 65535 (default: 7070; 0 picks a free port)
  --host <address>       Address to bind (default: 127.0.0.1). A non-loopback host needs a token.
  --token <value>        Require this token (Authorization: Bearer, or open /?token=<value> once).
                         Prefer PHARGUS_TOKEN: a flag shows up in the process list.
  --allowed-host <host>  Also answer requests whose Host header names <host> (repeatable).
                         A bare name matches any port; host:port matches exactly. Use it
                         when the browser reaches the dashboard by another name or IP, for
                         example --host 0.0.0.0 in a container. It does not replace the token.
  --window-ms <n>        Aggregation window in milliseconds (default: 1000)
  --max-line-bytes <n>   Longest accepted input line in bytes (default: 1048576)
  -h, --help             Print this help and exit
  -v, --version          Print the version and exit

Environment:
  PHARGUS_TOKEN          Token, used when --token is not given.
  PHARGUS_DEBUG          Any non-empty value prints stack traces with errors.
                         The agent ignores both variables, so an environment shared with
                         the monitored app is fine.

Exit codes:
  0  help, version, or a graceful shutdown on SIGINT/SIGTERM
  1  runtime error (unreadable input file, port in use, failed shutdown)
  2  usage error (unknown flag, bad value, non-loopback host without a token)

All diagnostics go to stderr; stdout carries only --help and --version.
`;
