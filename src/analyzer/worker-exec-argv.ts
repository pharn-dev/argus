/**
 * The `execArgv` the analyzer gives its Worker Threads.
 *
 * By default a Worker inherits the host's per-environment options, including ones that only make
 * sense for the host's entry point: a host started with `node --input-type=module -e '...'` passes
 * `--input-type` to every worker, which then fails with `ERR_INPUT_TYPE_NOT_ALLOWED` (surfaced by the
 * pool as `ERR_WORKER_CRASHED`). These helpers drop such flags.
 */

/** Flags that consume the next argv token as their value even when it starts with `-`. */
const ALWAYS_TAKES_VALUE = new Set(['-e', '--eval', '-p', '--print']);

/** Flags tied to the host's entry point, REPL, test runner, watcher or debugger port. */
const ENTRY_POINT_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-i',
  '--interactive',
  '-c',
  '--check',
  '--input-type',
  '--test',
  '--watch',
  '--watch-path',
  '--watch-preserve-output',
  '--entry-url',
]);

/** Prefixes of flag families that are tied to the host process (debugger ports, test runner). */
const ENTRY_POINT_PREFIXES = ['--inspect', '--debug', '--test-', '--watch-'];

/**
 * Per-environment flags a Worker accepts in an explicit `execArgv` and that can matter to worker
 * code (module loading, permissions, warnings, type stripping). Used only as a fallback when an
 * explicit list is rejected with `ERR_WORKER_INVALID_EXEC_ARGV` (V8 or per-process flags such as
 * `--max-old-space-size`, `--expose-gc` or `--title`, which a Worker cannot take).
 */
const PORTABLE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--enable-source-maps',
  '--no-warnings',
  '--disable-warning',
  '--no-deprecation',
  '--throw-deprecation',
  '--pending-deprecation',
  '--trace-deprecation',
  '--trace-warnings',
  '--trace-uncaught',
  '--unhandled-rejections',
  '--permission',
  '--experimental-permission',
  '--experimental-strip-types',
  '--no-experimental-strip-types',
  '--experimental-transform-types',
  '--experimental-vm-modules',
  '--experimental-require-module',
  '--no-experimental-require-module',
  '--preserve-symlinks',
]);

type FlagGroup = { name: string; tokens: string[] };

/** Splits an execArgv into flags, each with the value tokens that belong to it. */
function groupFlags(argv: readonly string[]): FlagGroup[] {
  const groups: FlagGroup[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const equals = token.indexOf('=');
    const name = token.startsWith('-') && equals > 0 ? token.slice(0, equals) : token;
    const group: FlagGroup = { name, tokens: [token] };
    if (equals < 0 && ALWAYS_TAKES_VALUE.has(name) && index + 1 < argv.length) {
      index += 1;
      group.tokens.push(argv[index] ?? '');
    } else {
      // execArgv holds no positional arguments, so a token not starting with `-` is a value.
      while (index + 1 < argv.length && !(argv[index + 1] ?? '').startsWith('-')) {
        index += 1;
        group.tokens.push(argv[index] ?? '');
      }
    }
    groups.push(group);
  }
  return groups;
}

function isEntryPointFlag(name: string): boolean {
  return ENTRY_POINT_FLAGS.has(name) || ENTRY_POINT_PREFIXES.some((p) => name.startsWith(p));
}

function isPortableFlag(name: string): boolean {
  return PORTABLE_FLAGS.has(name) || name.startsWith('--allow-');
}

/**
 * The `execArgv` for an analyzer worker: `undefined` (inherit, Node's default) when the host's
 * flags are all safe for a worker, else the host's flags minus the entry-point ones.
 */
export function workerExecArgv(
  hostExecArgv: readonly string[] = process.execArgv,
): string[] | undefined {
  const groups = groupFlags(hostExecArgv);
  if (!groups.some((group) => isEntryPointFlag(group.name))) return undefined;
  return groups.filter((group) => !isEntryPointFlag(group.name)).flatMap((group) => group.tokens);
}

/** The subset of `argv` made of flags a Worker is known to accept in an explicit `execArgv`. */
export function portableExecArgv(argv: readonly string[]): string[] {
  return groupFlags(argv)
    .filter((group) => isPortableFlag(group.name))
    .flatMap((group) => group.tokens);
}
