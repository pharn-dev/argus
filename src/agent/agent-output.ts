import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { assertPermission } from './permission.js';

/**
 * Open the NDJSON destination: `process.stdout` for 'stdout', otherwise an append-mode file stream.
 * Under the Node permission model a file destination needs an `fs.write` grant; without it this
 * throws `ArgusPermissionError` before any file is opened.
 */
export function openAgentOutput(output: string): Writable {
  if (output === 'stdout') {
    return process.stdout;
  }
  assertPermission('fs.write', output);
  return createWriteStream(output, { flags: 'a' });
}
