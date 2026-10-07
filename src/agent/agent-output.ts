import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { assertPermission } from './permission.js';

/** Mode for a newly created output file: owner read/write only. An existing file keeps its mode. */
export const AGENT_OUTPUT_FILE_MODE = 0o600;

/**
 * Open the NDJSON destination: `process.stdout` for 'stdout', otherwise an append-mode file stream
 * (created with mode 0600). Under the Node permission model a file destination needs an `fs.write`
 * grant; without it this throws `ArgusPermissionError` before any file is opened.
 */
export function openAgentOutput(output: string): Writable {
  if (output === 'stdout') {
    return process.stdout;
  }
  assertPermission('fs.write', output);
  return createWriteStream(output, { flags: 'a', mode: AGENT_OUTPUT_FILE_MODE });
}
