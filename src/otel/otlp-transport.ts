export type OtlpTarget = {
  url: string;
  /** Scheme, host and port only; the sole part of the URL ever put in an error message. */
  origin: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

/** Response body bytes read (and discarded) before the rest of the body is cancelled. */
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/**
 * Consumes a response body without buffering it: reads and discards at most `maxBytes`, then
 * cancels the rest, so a large or endless body costs no memory and the connection is released.
 * Rejects if reading fails (for example when the request signal aborts mid-body).
 */
async function discardResponseBody(response: Response, maxBytes: number): Promise<void> {
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

/**
 * Sends one OTLP JSON body with a single POST. Never throws or rejects: it resolves `undefined`
 * on a 2xx response and an `Error` otherwise. Only the origin appears in messages, never the
 * path, query or headers, which may carry a credential. A redirect is never followed (it is a
 * failure, and the redirect target is never contacted) and the response body is never buffered.
 * `abort`, when given, cancels the request early (used by a bounded `close()`).
 */
export async function postOtlpJson(
  target: OtlpTarget,
  body: string,
  abort?: AbortSignal,
): Promise<Error | undefined> {
  const timeout = AbortSignal.timeout(target.timeoutMs);
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json' },
      body,
      redirect: 'manual',
      signal: abort === undefined ? timeout : AbortSignal.any([timeout, abort]),
    });
    await discardResponseBody(response, MAX_RESPONSE_BODY_BYTES);
    if (response.status >= 200 && response.status < 300) return undefined;
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return new Error(
        `OTLP export to ${target.origin} failed: redirect (status ${String(response.status)}) not followed`,
      );
    }
    return new Error(`OTLP export to ${target.origin} failed: status ${String(response.status)}`);
  } catch (cause) {
    if (abort?.aborted === true) {
      return new Error(`OTLP export to ${target.origin} failed: aborted by close()`, { cause });
    }
    const name = cause instanceof Error ? cause.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new Error(
        `OTLP export to ${target.origin} failed: timed out after ${String(target.timeoutMs)}ms`,
        { cause },
      );
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new Error(`OTLP export to ${target.origin} failed: ${reason}`, { cause });
  }
}
