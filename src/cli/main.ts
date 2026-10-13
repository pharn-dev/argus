import { UsageError, parseServeArgs } from './args.js';
import { describeError, isDebug } from './report.js';
import { defaultServeIo, runServe, type ServeIo } from './serve.js';
import { USAGE } from './usage.js';
import { readPackageVersion } from './version.js';

export type MainIo = ServeIo & {
  /** Where `--help` and `--version` print; stdout, and the only thing that ever goes there. */
  stdout: (text: string) => void;
};

function defaultMainIo(): MainIo {
  return { ...defaultServeIo(), stdout: (text) => process.stdout.write(text) };
}

/**
 * Runs the CLI for `argv` (without the node and script entries) and returns the exit code:
 * 0 for help, version or a graceful shutdown, 2 for a usage error, 1 for a runtime error.
 */
export async function main(argv: readonly string[], io: MainIo = defaultMainIo()): Promise<number> {
  try {
    const parsed = parseServeArgs(argv, io.env);
    if (parsed.kind === 'help') {
      io.stdout(USAGE);
      return 0;
    }
    if (parsed.kind === 'version') {
      io.stdout(`${readPackageVersion()}\n`);
      return 0;
    }
    return await runServe(parsed.options, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.write(error.message);
      io.write("run 'phargus --help' for usage");
      return error.exitCode;
    }
    io.write(describeError(error, isDebug(io.env)));
    return 1;
  }
}
