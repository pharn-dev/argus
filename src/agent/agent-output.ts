import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';

/** Open the NDJSON destination: `process.stdout` for 'stdout', otherwise an append-mode file stream. */
export function openAgentOutput(output: string): Writable {
  if (output === 'stdout') {
    return process.stdout;
  }
  return createWriteStream(output, { flags: 'a' });
}
