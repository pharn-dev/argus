/// <reference types="node" />
import { openAgentOutput } from './agent-output.js';
import { loadAgentConfig } from './config.js';
import { createNdjsonExporter } from './ndjson-exporter.js';
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
    return;
  }
  const destination = openAgentOutput(config.output);
  const exporter = createNdjsonExporter(destination, { queueBound: config.queueBound });
  const controller = createSamplerController((sample) => {
    exporter.export(sample);
  });
  const disable = (err: unknown): void => {
    controller.stop();
    reportOnce(err);
  };
  // pipeline() does not settle while the exporter's source is idle, so listen on the destination too.
  destination.once('error', disable);
  exporter.done.then(undefined, disable);
  controller.start(config.intervalMs);
}

/** Start the agent once per process (shared across ESM/CJS copies via globalThis). Never throws. */
export function startAgentOnce(): void {
  try {
    const g = globalThis as AgentGlobal;
    if (g[AGENT_KEY] === true) {
      return;
    }
    g[AGENT_KEY] = true;
    start().catch(reportOnce);
  } catch (err) {
    reportOnce(err);
  }
}
