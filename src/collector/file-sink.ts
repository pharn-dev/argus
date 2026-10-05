import { open, type FileHandle } from 'node:fs/promises';
import type { Alert } from './alert-evaluator.js';
import {
  reportSinkError,
  sinkLabel,
  toError,
  type AlertSink,
  type SinkErrorHandler,
} from './alert-sink.js';

export type FileSinkOptions = {
  path: string;
  name?: string;
  onError?: SinkErrorHandler;
};

/** Appends each alert as one NDJSON line to a file (append mode; existing content is kept). */
export function createFileSink(options: FileSinkOptions): AlertSink {
  const { path, name, onError } = options;
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError(`${sinkLabel('file', name)}: path must be a non-empty string`);
  }
  let failed = 0;
  let dropped = 0;
  let closed = false;
  let handle: FileHandle | undefined;
  let tail: Promise<void> = Promise.resolve();

  const fail = (what: string, error: unknown): void => {
    failed += 1;
    const cause = toError(error);
    reportSinkError(
      onError,
      new Error(`${sinkLabel('file', name)}: ${what} failed: ${cause.message}`, { cause }),
      sink,
    );
  };

  const sink: AlertSink = {
    type: 'file',
    name,
    get failed(): number {
      return failed;
    },
    get dropped(): number {
      return dropped;
    },
    send(alert: Alert): Promise<void> {
      if (closed) {
        dropped += 1;
        return Promise.resolve();
      }
      tail = tail.then(async () => {
        try {
          handle ??= await open(path, 'a');
        } catch (error) {
          fail('open', error);
          return;
        }
        try {
          await handle.appendFile(`${JSON.stringify(alert)}\n`);
        } catch (error) {
          fail('append', error);
        }
      });
      return tail;
    },
    async close(): Promise<void> {
      closed = true;
      await tail;
      const open_ = handle;
      handle = undefined;
      if (open_ !== undefined) {
        try {
          await open_.close();
        } catch (error) {
          fail('close', error);
        }
      }
    },
  };

  return sink;
}
