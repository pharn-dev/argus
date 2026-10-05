import { setTimeout as sleep } from 'node:timers/promises';
import type { Alert } from './alert-evaluator.js';
import {
  reportSinkError,
  sinkLabel,
  toError,
  type AlertSink,
  type SinkErrorHandler,
} from './alert-sink.js';

export type WebhookSinkOptions = {
  url: string;
  name?: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxInFlight?: number;
  onError?: SinkErrorHandler;
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 100;
const DEFAULT_MAX_IN_FLIGHT = 100;

/** POSTs each alert as JSON with a per-request timeout, bounded retries and a bounded in-flight count. */
export function createWebhookSink(options: WebhookSinkOptions): AlertSink {
  const { name, onError } = options;
  const label = sinkLabel('webhook', name);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;

  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch (error) {
    throw new TypeError(`${label}: url is not a valid URL`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label}: url protocol must be http: or https:, got ${parsed.protocol}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${label}: timeoutMs must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) {
    throw new RangeError(`${label}: maxInFlight must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new RangeError(`${label}: retries must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0) {
    throw new RangeError(`${label}: backoffMs must be a non-negative safe integer`);
  }

  const url = parsed.href;
  const origin = parsed.origin;
  let failed = 0;
  let dropped = 0;
  let closed = false;
  let inFlight = 0;
  const pending = new Set<Promise<void>>();

  async function attempt(alert: Alert): Promise<{ ok: boolean; retry: boolean; reason: string }> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alert),
        signal,
      });
      await response.arrayBuffer();
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, retry: false, reason: '' };
      }
      return {
        ok: false,
        retry: response.status >= 500,
        reason: `status ${response.status}`,
      };
    } catch (error) {
      return { ok: false, retry: true, reason: toError(error).message };
    }
  }

  async function deliver(alert: Alert): Promise<void> {
    let last = { ok: false, retry: true, reason: 'no attempt made' };
    for (let n = 0; n <= retries; n += 1) {
      last = await attempt(alert);
      if (last.ok) {
        return;
      }
      if (!last.retry || n === retries) {
        break;
      }
      await sleep(backoffMs * 2 ** n);
    }
    failed += 1;
    reportSinkError(
      onError,
      new Error(`${label}: delivery to ${origin} failed: ${last.reason}`),
      sink,
    );
  }

  const sink: AlertSink = {
    type: 'webhook',
    name,
    get failed(): number {
      return failed;
    },
    get dropped(): number {
      return dropped;
    },
    send(alert: Alert): Promise<void> {
      if (closed || inFlight >= maxInFlight) {
        dropped += 1;
        reportSinkError(
          onError,
          new RangeError(
            `${label}: alert dropped (${closed ? 'sink closed' : `maxInFlight ${maxInFlight} reached`})`,
          ),
          sink,
        );
        return Promise.resolve();
      }
      inFlight += 1;
      const delivery = deliver(alert).finally(() => {
        inFlight -= 1;
        pending.delete(delivery);
      });
      pending.add(delivery);
      return delivery;
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };

  return sink;
}
