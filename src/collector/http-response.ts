/** Response body bytes read (and discarded) before the rest of the body is cancelled. */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/** True for a 3xx response. Requests use `redirect: 'manual'`, so a redirect is never followed. */
export function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * Consumes a fetch response body without buffering it: reads and discards at most `maxBytes`,
 * then cancels the rest. A large or endless body costs no memory, and the body is always
 * consumed or cancelled so the connection is released. Rejects if reading fails (for example
 * when the request signal aborts mid-body).
 */
export async function discardResponseBody(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BODY_BYTES,
): Promise<void> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  let read = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      // fetch body chunks are Uint8Array; the platform typings declare the stream untyped, so
      // anything else is treated as over the cap and cancels the body.
      const value: unknown = chunk.value;
      read += value instanceof Uint8Array ? value.byteLength : maxBytes + 1;
      if (read > maxBytes) {
        await reader.cancel();
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
