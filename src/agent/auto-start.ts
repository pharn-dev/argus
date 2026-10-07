/// <reference types="node" />
import { openAgentOutput } from './agent-output.js';
import { loadAgentConfig } from './config.js';
import { enable as enableTracing, disable as disableTracing, drainSpans } from './http-tracing.js';
import { createNdjsonExporter } from './ndjson-exporter.js';
import { createSpanExport } from './span-export.js';
import { createSamplerController } from './sampler-controller.js';

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

async function start(): Promise<void> {
  const config = await loadAgentConfig(process.cwd(), process.env);
  if (!config.enabled || config.output === 'none') {
    disableTracing();
    return;
  }
  const destination = openAgentOutput(config.output);
  const exporter = createNdjsonExporter(destination, { queueBound: config.queueBound });
  const spans = createSpanExport(drainSpans, (record) => exporter.export(record));
  let disable = (err: unknown): void => {
    reportOnce(err);
  };
  const flushSpans = (): void => {
    try {
      spans.flush();
    } catch (err) {
      disable(err);
    }
  };
  const onBeforeExit = (): void => {
    flushSpans();
  };
  process.once('beforeExit', onBeforeExit);
  const controller = createSamplerController((sample) => {
    exporter.export(sample);
    flushSpans();
  });
  disable = (err: unknown): void => {
    controller.stop();
    disableTracing();
    process.off('beforeExit', onBeforeExit);
    reportOnce(err);
  };
  // pipeline() does not settle while the exporter's source is idle, so listen on the destination too.
  destination.once('error', disable);
  exporter.done.then(undefined, disable);
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
