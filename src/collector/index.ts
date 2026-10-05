import type { ArgusAgentPlaceholder } from '../agent/index.js';

/** Scaffold placeholder — kept so the scaffold test stays valid. */
export type CollectorPlaceholder = ArgusAgentPlaceholder;

export { createWindowAggregator, type WindowAggregatorOptions } from './window-aggregator.js';
export { createRingBuffer, type RingBuffer } from './ring-buffer.js';
export { createCollector, type Collector, type CollectorOptions } from './collector.js';
export type { AggregatedWindow } from './window.js';
export { createAlertEvaluator, type Alert, type AlertState } from './alert-evaluator.js';
export {
  validateAlertRules,
  type AlertComparison,
  type AlertMetric,
  type AlertRule,
} from './alert-rules.js';
