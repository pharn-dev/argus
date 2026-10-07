import type { Writable } from 'node:stream';
import { sinkLabel, type AlertSink, type SinkErrorHandler } from './alert-sink.js';
import { createFileSink } from './file-sink.js';
import { createStdoutSink } from './stdout-sink.js';
import { createWebhookSink } from './webhook-sink.js';

export type SinkConfig =
  | { type: 'stdout'; name?: string; stream?: Writable }
  | { type: 'file'; name?: string; path: string }
  | {
      type: 'webhook';
      name?: string;
      url: string;
      timeoutMs?: number;
      retries?: number;
      backoffMs?: number;
      maxInFlight?: number;
      closeTimeoutMs?: number;
    };

export type SinkInput = AlertSink | SinkConfig;

const SINK_TYPES: ReadonlySet<string> = new Set(['stdout', 'file', 'webhook']);

function isSinkInstance(input: unknown): input is AlertSink {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { send?: unknown }).send === 'function' &&
    typeof (input as { close?: unknown }).close === 'function'
  );
}

function build(config: SinkConfig, onError: SinkErrorHandler | undefined): AlertSink {
  // Optional properties are copied only when defined (exactOptionalPropertyTypes).
  const common = {
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(onError !== undefined ? { onError } : {}),
  };
  switch (config.type) {
    case 'stdout':
      return createStdoutSink({
        ...common,
        ...(config.stream !== undefined ? { stream: config.stream } : {}),
      });
    case 'file':
      return createFileSink({ ...common, path: config.path });
    case 'webhook':
      return createWebhookSink({
        ...common,
        url: config.url,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.retries !== undefined ? { retries: config.retries } : {}),
        ...(config.backoffMs !== undefined ? { backoffMs: config.backoffMs } : {}),
        ...(config.maxInFlight !== undefined ? { maxInFlight: config.maxInFlight } : {}),
        ...(config.closeTimeoutMs !== undefined ? { closeTimeoutMs: config.closeTimeoutMs } : {}),
      });
  }
}

/** Resolves sink inputs (instances or configs) into sinks; validates everything up front. */
export function createSinks(
  inputs: readonly SinkInput[] | undefined,
  onError?: SinkErrorHandler,
): AlertSink[] {
  if (inputs === undefined) {
    return [];
  }
  if (!Array.isArray(inputs)) {
    throw new TypeError('sinks must be an array');
  }
  return (inputs as readonly SinkInput[]).map((input, index) => {
    if (isSinkInstance(input)) {
      return input;
    }
    const config = input;
    const type: unknown = config?.type;
    if (typeof type !== 'string' || !SINK_TYPES.has(type)) {
      throw new RangeError(`sink [${index}]: unknown sink type "${String(type)}"`);
    }
    try {
      return build(config, onError);
    } catch (error) {
      if (error instanceof Error) {
        const Ctor = error.constructor as new (message: string, options?: ErrorOptions) => Error;
        throw new Ctor(`${sinkLabel(config.type, config.name, index)}: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
  });
}
