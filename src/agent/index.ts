/** Scaffold placeholder, still imported by the collector. */
export type ArgusAgentPlaceholder = void;

export { createEventLoopSampler } from './event-loop-sampler.js';
export type { EventLoopSample, EventLoopSampler } from './event-loop-sampler.js';
export { createGcSampler } from './gc-sampler.js';
export type { GcSample, GcSampler } from './gc-sampler.js';
export { sampleMemory } from './memory-sampler.js';
export type { MemorySample } from './memory-sampler.js';
export { sampleHeapSpaces } from './heap-space-sampler.js';
export type { HeapSpaceEntry, HeapSpaceSample } from './heap-space-sampler.js';
export { takeHeapSnapshot } from './heap-snapshot.js';
export type { HeapSnapshotOptions, HeapSnapshotResult } from './heap-snapshot.js';
export {
  sampleAllocations,
  DEFAULT_ALLOCATION_SAMPLING_INTERVAL,
  DEFAULT_ALLOCATION_SAMPLING_DURATION_MS,
  DEFAULT_ALLOCATION_SITE_LIMIT,
} from './allocation-sampler.js';
export type { AllocationSamplingOptions } from './allocation-sampler.js';
export type { AllocationSite } from './allocation-profile.js';
export { createBackpressureProbe } from './backpressure-probe.js';
export type {
  BackpressureHotspot,
  BackpressureProbe,
  BackpressureProbeOptions,
  BackpressureSample,
} from './backpressure-probe.js';
export { createSamplerController } from './sampler-controller.js';
export type { AgentSample, SamplerController } from './sampler-controller.js';
export { encodeNdjsonLine } from './ndjson-encoder.js';
export { createNdjsonExporter } from './ndjson-exporter.js';
export type { NdjsonExporter, NdjsonExporterOptions } from './ndjson-exporter.js';
export { loadAgentConfig } from './config.js';
export { defaultAgentConfig, ArgusConfigError } from './config-schema.js';
export type { AgentConfig } from './config-schema.js';
export { createDeoptParser, ANONYMOUS_FUNCTION, DEPENDENT_CODE_KIND } from './deopt-parser.js';
export type { DeoptEvent, DeoptLocation, DeoptParser } from './deopt-parser.js';
export { currentTraceId, runWithTrace } from './context.js';
export { enable, disable, drainSpans, DEFAULT_SPAN_BUFFER_SIZE } from './http-tracing.js';
export type { HttpTracingOptions } from './http-tracing.js';
export type { TraceSpan, SpanDrain } from './span-buffer.js';
