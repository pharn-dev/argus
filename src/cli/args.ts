import { parseArgs } from 'node:util';
import { DEFAULT_MAX_LINE_BYTES } from '../collector/index.js';
import { isLoopbackHost } from '../dashboard/index.js';

/** A bad command line: reported as `phargus: <message>` and exit code 2, never with a stack. */
export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type ServeInput = { kind: 'stdin' } | { kind: 'file'; path: string };

export type ServeOptions = {
  port: number;
  host: string;
  token: string | undefined;
  windowMs: number;
  maxLineBytes: number;
  input: ServeInput;
};

export type ParsedArgs =
  { kind: 'help' } | { kind: 'version' } | { kind: 'serve'; options: ServeOptions };

export const DEFAULT_PORT = 7070;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_WINDOW_MS = 1000;

const DIGITS = /^[0-9]+$/;
const PORT_DIGITS = /^[0-9]{1,5}$/;

function parsePort(value: string): number {
  const port = PORT_DIGITS.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new UsageError(`--port must be an integer from 0 to 65535, got "${value}"`);
  }
  return port;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = DIGITS.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Parses `argv` (without the node and script entries). `--help` and `--version` win over
 * everything else. The token comes from `--token`, else a non-empty `PHARGUS_TOKEN`; a host that is
 * not loopback without a token is refused here, before anything binds.
 */
export function parseServeArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        port: { type: 'string' },
        host: { type: 'string' },
        token: { type: 'string' },
        'window-ms': { type: 'string' },
        'max-line-bytes': { type: 'string' },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) {
      // Strict parseArgs reports unknown flags and missing values by name (`Unknown option '--bogus'`).
      throw new UsageError(error.message);
    }
    throw error;
  }

  const { values, positionals } = parsed;
  if (values.help === true) {
    return { kind: 'help' };
  }
  if (values.version === true) {
    return { kind: 'version' };
  }

  const [command, ...rest] = positionals;
  if (command === undefined) {
    throw new UsageError("no command given; expected 'serve'");
  }
  if (command !== 'serve') {
    throw new UsageError(`unknown command "${command}"; expected 'serve'`);
  }
  if (rest.length > 1) {
    throw new UsageError(
      `serve takes at most one input (a file path or "-" for stdin), got ${String(rest.length)}`,
    );
  }

  const port = values.port === undefined ? DEFAULT_PORT : parsePort(values.port);
  const windowMs =
    values['window-ms'] === undefined
      ? DEFAULT_WINDOW_MS
      : parsePositiveInteger('--window-ms', values['window-ms']);
  const maxLineBytes =
    values['max-line-bytes'] === undefined
      ? undefined
      : parsePositiveInteger('--max-line-bytes', values['max-line-bytes']);

  const host = values.host ?? DEFAULT_HOST;
  if (host.length === 0) {
    throw new UsageError('--host must not be empty');
  }
  if (values.token !== undefined && values.token.length === 0) {
    throw new UsageError('--token must not be empty');
  }
  const envToken = env['PHARGUS_TOKEN'];
  const token = values.token ?? (envToken === undefined || envToken === '' ? undefined : envToken);
  if (!isLoopbackHost(host) && token === undefined) {
    throw new UsageError(
      `a token is required to bind --host "${host}" because it is not a loopback address; ` +
        'pass --token or set PHARGUS_TOKEN',
    );
  }

  const [spec] = rest;
  const input: ServeInput =
    spec === undefined || spec === '-' ? { kind: 'stdin' } : { kind: 'file', path: spec };

  return {
    kind: 'serve',
    options: {
      port,
      host,
      token,
      windowMs,
      maxLineBytes: maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      input,
    },
  };
}
