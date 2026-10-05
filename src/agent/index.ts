/** Scaffold placeholder, still imported by the collector. */
export type ArgusAgentPlaceholder = void;

export { createEventLoopSampler } from './event-loop-sampler.js';
export type { EventLoopSample, EventLoopSampler } from './event-loop-sampler.js';
export { sampleMemory } from './memory-sampler.js';
export type { MemorySample } from './memory-sampler.js';
export { createSamplerController } from './sampler-controller.js';
export type { AgentSample, SamplerController } from './sampler-controller.js';
