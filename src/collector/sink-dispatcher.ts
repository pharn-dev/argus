import type { Alert } from './alert-evaluator.js';
import { reportSinkError, toError, type AlertSink, type SinkErrorHandler } from './alert-sink.js';

export type SinkDispatcher = {
  /** Starts delivery to every sink without awaiting; never throws. */
  deliver(alert: Alert): void;
  /** Resolves once every started delivery has settled. */
  settle(): Promise<void>;
  /** Settles, then closes every sink; close failures are reported. */
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
      await settle();
      const results = await Promise.allSettled(sinks.map((sink) => sink.close()));
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          reportSinkError(onError, toError(result.reason), sinks[i] as AlertSink);
        }
      });
    },
  };
}
