import type { Alert } from './alert-evaluator.js';

/**
 * A destination for collector alerts.
 *
 * Contract: `send()` never rejects for a delivery failure. A failure increments `failed`
 * and is reported through the sink's error handler. `close()` waits for queued and
 * in-flight deliveries to settle; a sink that talks to the network bounds that wait (the
 * webhook sink aborts what is still in flight after its `closeTimeoutMs`, counting it as
 * `failed`). `send()` after `close()` resolves immediately and counts as `dropped`.
 */
export type AlertSink = {
  readonly type: string;
  readonly name: string | undefined;
  /** Alerts whose delivery failed (integer, once per alert). */
  readonly failed: number;
  /** Alerts discarded without a delivery attempt (integer). */
  readonly dropped: number;
  send(alert: Alert): Promise<void>;
  close(): Promise<void>;
};

export type SinkErrorHandler = (error: Error, sink: AlertSink) => void;

/** Builds the `"<type> sink "<name>" [<index>]"` prefix used in every sink message. */
export function sinkLabel(type: string, name?: string, index?: number): string {
  let label = `${type} sink`;
  if (name !== undefined) {
    label += ` "${name}"`;
  }
  if (index !== undefined) {
    label += ` [${index}]`;
  }
  return label;
}

/**
 * Routes a sink failure to the handler. Without a handler, or when the handler itself
 * throws, the error goes to `process.emitWarning` so a failure is never silent.
 */
export function reportSinkError(
  handler: SinkErrorHandler | undefined,
  error: Error,
  sink: AlertSink,
): void {
  if (handler !== undefined) {
    try {
      handler(error, sink);
      return;
    } catch (handlerError) {
      process.emitWarning(handlerError instanceof Error ? handlerError : String(handlerError));
    }
  }
  process.emitWarning(error);
}

/** Normalizes an unknown thrown value into an Error. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export type { Alert };
