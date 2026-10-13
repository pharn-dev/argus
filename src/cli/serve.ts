import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { createCollector, createNdjsonDecoder } from '../collector/index.js';
import { createDashboardServer, type DashboardServer } from '../dashboard/index.js';
import type { ServeOptions } from './args.js';
import { openInput, type OpenedInput } from './input.js';
import { describeError, formatCounts, isDebug, writeLine } from './report.js';

/** Windows kept for replay: five minutes at the default one-second window, as in the README. */
const RING_CAPACITY = 300;
/** How long a graceful shutdown may take before the process is forced out with exit code 1. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

type SignalSource = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
};

/** The process-level things `runServe` touches, so its lifecycle can be driven from a test. */
export type ServeIo = {
  env: NodeJS.ProcessEnv;
  stdin: () => Readable;
  signals: SignalSource;
  write: (text: string) => void;
  forceExit: (code: number) => void;
};

export function defaultServeIo(): ServeIo {
  return {
    env: process.env,
    stdin: () => process.stdin,
    signals: process,
    write: writeLine,
    forceExit: (code) => process.exit(code),
  };
}

const SIGNALS: readonly ('SIGINT' | 'SIGTERM')[] = ['SIGINT', 'SIGTERM'];

/**
 * Wires input, decoder, collector and dashboard together and resolves with the exit code once the
 * process has shut down: 0 after a graceful stop, 1 after a runtime failure. Startup failures
 * (unreadable file, port in use) surface before any input is read.
 */
export async function runServe(
  options: ServeOptions,
  io: ServeIo = defaultServeIo(),
): Promise<number> {
  const debug = isDebug(io.env);
  const { write } = io;

  let input: OpenedInput;
  try {
    input = await openInput(options.input, io.stdin);
  } catch (error) {
    write(describeError(error, debug));
    return 1;
  }

  const collector = createCollector({
    windowMs: options.windowMs,
    capacity: RING_CAPACITY,
  });
  const decoder = createNdjsonDecoder({ maxLineBytes: options.maxLineBytes });

  let dashboard: DashboardServer;
  try {
    dashboard = await createDashboardServer({
      collector,
      host: options.host,
      port: options.port,
      ...(options.token === undefined ? {} : { token: options.token }),
      onError: (error) => {
        write(`dashboard error: ${describeError(error, debug)}`);
      },
    });
  } catch (error) {
    write(
      `cannot start the dashboard on ${options.host}:${String(options.port)}: ${describeError(error, debug)}`,
    );
    await Promise.allSettled([input.close(), collector.close()]);
    return 1;
  }

  const counts = (): string =>
    formatCounts({
      invalid: decoder.invalid,
      oversized: decoder.oversized,
      ignored: collector.ignored,
      droppedEvents: dashboard.droppedEvents,
    });

  write(`dashboard at ${dashboard.url}`);
  if (options.token !== undefined) {
    write(
      `a token is required: open ${dashboard.url}/?token=<token> once, or send Authorization: Bearer <token>`,
    );
  }

  const abort = new AbortController();
  let shuttingDown = false;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const shutdown = async (code: number): Promise<void> => {
    shuttingDown = true;
    let exitCode = code;
    const timer = setTimeout(() => {
      write(`shutdown did not finish within ${String(SHUTDOWN_TIMEOUT_MS)} ms, forcing exit`);
      write(counts());
      io.forceExit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    abort.abort();
    const steps: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      ['input', () => input.close()],
      ['dashboard', () => dashboard.close()],
      ['collector', () => collector.close()],
    ];
    for (const [name, close] of steps) {
      try {
        await close();
      } catch (error) {
        write(`closing the ${name} failed: ${describeError(error, debug)}`);
        exitCode = 1;
      }
    }
    write(counts());
    clearTimeout(timer);
    for (const signal of SIGNALS) {
      io.signals.off(signal, handlers[signal]);
    }
    resolveExit(exitCode);
  };

  const handlers: Record<'SIGINT' | 'SIGTERM', () => void> = {
    SIGINT: () => onSignal('SIGINT'),
    SIGTERM: () => onSignal('SIGTERM'),
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      write(`received ${signal} again during shutdown, exiting now`);
      io.forceExit(1);
      return;
    }
    write(`received ${signal}, shutting down`);
    void shutdown(0);
  };
  for (const signal of SIGNALS) {
    io.signals.on(signal, handlers[signal]);
  }

  pipeline(input.stream, decoder, (records) => collector.consume(records), {
    signal: abort.signal,
  }).then(
    () => {
      write('input ended; still serving the collected data (Ctrl-C to stop)');
      write(counts());
    },
    (error: unknown) => {
      if (shuttingDown) {
        // Aborted by the shutdown that is already under way: expected, not a failure.
        return;
      }
      write(`input failed: ${describeError(error, debug)}`);
      void shutdown(1);
    },
  );

  return exited;
}
