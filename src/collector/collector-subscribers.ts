import type { SpanRecord } from '../agent/index.js';
import type { Alert } from './alert-evaluator.js';
import type { AggregatedWindow } from './window.js';

/** A live observer of the collector's recorded windows and alerts. */
export type CollectorListener = {
  window?(window: AggregatedWindow): void;
  alert?(alert: Alert): void;
  span?(span: SpanRecord): void;
};

export type SubscriberSet = {
  add(listener: CollectorListener): () => void;
  emitWindow(window: AggregatedWindow): void;
  emitAlert(alert: Alert): void;
  emitSpan(span: SpanRecord): void;
};

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`collector listener threw: ${message}`);
}

export function createSubscriberSet(): SubscriberSet {
  const listeners = new Set<CollectorListener>();
  return {
    add(listener: CollectorListener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    emitWindow(window: AggregatedWindow): void {
      for (const listener of [...listeners]) {
        try {
          listener.window?.(window);
        } catch (error) {
          report(error);
        }
      }
    },
    emitAlert(alert: Alert): void {
      for (const listener of [...listeners]) {
        try {
          listener.alert?.(alert);
        } catch (error) {
          report(error);
        }
      }
    },
    emitSpan(span: SpanRecord): void {
      for (const listener of [...listeners]) {
        try {
          listener.span?.(span);
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
