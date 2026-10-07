/// <reference types="node" />
import type { Writable } from 'node:stream';
import { openAgentOutput } from './agent-output.js';
import { loadAgentConfig } from './config.js';
import { enable as enableTracing, disable as disableTracing, drainSpans } from './http-tracing.js';
import { createNdjsonExporter } from './ndjson-exporter.js';
import { createSpanExport } from './span-export.js';
import { createSamplerController } from './sampler-controller.js';
import type { AgentSample } from './sampler-controller.js';
import type { SpanDrain } from './span-buffer.js';
import type { AgentLossCounters, AgentSampleLine } from './span-record.js';

const AGENT_KEY = Symbol.for('argus.agent');

type AgentGlobal = { [AGENT_KEY]?: true };

let reported = false;

/** Write at most one `[argus]` line per process; reporting itself never throws. */
function reportOnce(err: unknown): void {
  if (reported) {
    return;
  }
  reported = true;
  try {
    const message = err instanceof Error ? err.message : String(err);
    const oneLine = message.replace(/\s+/g, ' ').trim();
    process.stderr.write(`[argus] agent disabled: ${oneLine}\n`);
  } catch {
    // Reporting must never throw into the monitored process; stderr is the only channel.
  }
}

export type AgentExportOptions = {
  /** Bound of each output lane: sample lines and span lines are queued separately. */
  queueBound: number;
};

export type AgentExport = {
  /** Move the tracer's buffered spans into the span lane. Throws what the drain throws. */
  flushSpans(): void;
  /** Queue one sample line carrying the cumulative loss counters. */
  exportSample(sample: AgentSample): void;
  /** Cumulative integer loss counters, as the next sample line will carry them. */
  readonly dropped: AgentLossCounters;
  /** Flush both lanes and end the destination. */
  stop(): Promise<void>;
  /** The exporter's pipeline() result. */
  readonly done: Promise<void>;
};

/**
 * The agent's output wiring: one NDJSON pipeline with a sample lane and a span lane. Samples are
 * written first and never evicted by spans; each lane drops its own oldest lines when the
 * destination stalls, and every sample line reports the cumulative drops as `dropped`.
 */
export function createAgentExport(
  destination: Writable,
  options: AgentExportOptions,
  drain: () => SpanDrain,
): AgentExport {
  const exporter = createNdjsonExporter(destination, {
    queueBound: options.queueBound,
    spanQueueBound: options.queueBound,
  });
  const spans = createSpanExport(drain, (record) => exporter.exportSpan(record));
  const lossCounters = (): AgentLossCounters => ({
    samples: exporter.droppedRecords,
    spans: spans.dropped + exporter.droppedSpans,
  });
  return {
    flushSpans(): void {
      spans.flush();
    },
    exportSample(sample: AgentSample): void {
      const line: AgentSampleLine = { ...sample, dropped: lossCounters() };
      exporter.export(line);
    },
    get dropped(): AgentLossCounters {
      return lossCounters();
    },
    stop(): Promise<void> {
      return exporter.stop();
    },
    done: exporter.done,
  };
}

async function start(): Promise<void> {
  const config = await loadAgentConfig(process.cwd(), process.env);
  if (!config.enabled || config.output === 'none') {
    disableTracing();
    return;
  }
  const destination = openAgentOutput(config.output);
  const output = createAgentExport(destination, { queueBound: config.queueBound }, drainSpans);
  let disable = (err: unknown): void => {
    reportOnce(err);
  };
  const flushSpans = (): void => {
    try {
      output.flushSpans();
    } catch (err) {
      disable(err);
    }
  };
  const onBeforeExit = (): void => {
    flushSpans();
  };
  process.once('beforeExit', onBeforeExit);
  const controller = createSamplerController((sample) => {
    // Spans first, so this sample's `dropped` includes the tick's drain; the sample lane is
    // still written ahead of every queued span.
    flushSpans();
    try {
      output.exportSample(sample);
    } catch (err) {
      disable(err);
    }
  });
  disable = (err: unknown): void => {
    controller.stop();
    disableTracing();
    process.off('beforeExit', onBeforeExit);
    reportOnce(err);
  };
  // pipeline() does not settle while the exporter's source is idle, so listen on the destination too.
  destination.once('error', disable);
  output.done.then(undefined, disable);
  controller.start(config.intervalMs);
}

/** A failed start switches tracing back off and reports once; it never throws. */
function failStart(err: unknown): void {
  try {
    disableTracing();
  } catch (disableError) {
    reportOnce(new AggregateError([err, disableError], 'start failed and tracing stayed on'));
    return;
  }
  reportOnce(err);
}

/** Start the agent once per process (shared across ESM/CJS copies via globalThis). Never throws. */
export function startAgentOnce(): void {
  try {
    const g = globalThis as AgentGlobal;
    if (g[AGENT_KEY] === true) {
      return;
    }
    g[AGENT_KEY] = true;
    // Trace from the first tick: requests that arrive while the config loads still get spans.
    // The buffer is bounded, and tracing is switched off again if the agent ends up disabled.
    enableTracing();
    start().catch(failStart);
  } catch (err) {
    failStart(err);
  }
}
