import type { Alert } from './alert-evaluator.js';
import { reportSinkError, toError, type AlertSink, type SinkErrorHandler } from './alert-sink.js';

export type SinkDispatcher = {
  /** Starts delivery to every sink without awaiting; never throws. */
  deliver(alert: Alert): void;
  /** Resolves once every started delivery has settled. */
  settle(): Promise<void>;
  /**
   * Closes every sink, then settles. Each sink bounds its own shutdown, so this is as slow as the
   * slowest sink's close, not the slowest retry sequence. Close failures are reported.
   */
  close(): Promise<void>;
};

export function createSinkDispatcher(
  sinks: readonly AlertSink[],
  onError?: SinkErrorHandler,
): SinkDispatcher {
  const pending = new Set<Promise<void>>();

  async function settle(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  return {
    deliver(alert: Alert): void {
      for (const sink of sinks) {
        const task: Promise<void> = Promise.resolve()
          .then(() => sink.send(alert))
          .catch((error: unknown) => {
            reportSinkError(onError, toError(error), sink);
          })
          .finally(() => {
            pending.delete(task);
          });
        pending.add(task);
      }
    },
    settle,
    async close(): Promise<void> {
      // `deliver()` calls `send()` from an already queued microtask; closing from a microtask
      // queued after it guarantees every started delivery reaches its sink before the sink closes.
      const results = await Promise.allSettled(
        sinks.map((sink) => Promise.resolve().then(() => sink.close())),
      );
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          reportSinkError(onError, toError(result.reason), sinks[i] as AlertSink);
        }
      });
      await settle();
    },
  };
}
