/**
 * Encode one record as a single NDJSON line (JSON text plus a trailing newline).
 * Encode failures (a cycle, a BigInt) propagate as the TypeError JSON.stringify throws.
 */
export function encodeNdjsonLine(record: unknown): string {
  const text = JSON.stringify(record) as string | undefined;
  if (text === undefined) {
    throw new TypeError('record is not JSON-serializable (undefined, function or symbol)');
  }
  return `${text}\n`;
}
