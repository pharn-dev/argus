import type { PhargusAgentPlaceholder } from '../agent/index.js';

/** Scaffold placeholder — kept so the scaffold test stays valid. */
export type CollectorPlaceholder = PhargusAgentPlaceholder;

export { createWindowAggregator, type WindowAggregatorOptions } from './window-aggregator.js';
export { createRingBuffer, type RingBuffer } from './ring-buffer.js';
export { createSpanRouter } from './span-router.js';
export type { SpanRecord } from '../agent/index.js';
export {
  createCollector,
  DEFAULT_SPAN_CAPACITY,
  type Collector,
  type CollectorOptions,
  type WindowPersistence,
} from './collector.js';
export { createWindowStore, type PersistOptions, type WindowStore } from './window-store.js';
export { serializeWindow, parseWindowLine } from './window-codec.js';
export {
  createNdjsonDecoder,
  DEFAULT_MAX_LINE_BYTES,
  type NdjsonDecoder,
  type NdjsonDecoderOptions,
  type NdjsonSkip,
} from './ndjson-decoder.js';
export type { IgnoredReason, IgnoredRecordHandler } from './record-guard.js';
export type { CollectorListener } from './collector-subscribers.js';
export type { AggregatedWindow } from './window.js';
export { createAlertEvaluator, type Alert, type AlertState } from './alert-evaluator.js';
export {
  validateAlertRules,
  type AlertComparison,
  type AlertMetric,
  type AlertRule,
} from './alert-rules.js';
export type { AlertSink, SinkErrorHandler } from './alert-sink.js';
export { createStdoutSink, type StdoutSinkOptions } from './stdout-sink.js';
export { createFileSink, type FileSinkOptions } from './file-sink.js';
export { createWebhookSink, type WebhookSinkOptions } from './webhook-sink.js';
export { createSinks, type SinkConfig, type SinkInput } from './sink-config.js';
