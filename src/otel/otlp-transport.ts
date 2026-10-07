export type OtlpTarget = {
  url: string;
  /** Scheme, host and port only; the sole part of the URL ever put in an error message. */
  origin: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

/**
 * Sends one OTLP JSON body with a single POST. Never throws or rejects: it resolves `undefined`
 * on a 2xx response and an `Error` otherwise. Only the origin appears in messages, never the
 * path, query or headers, which may carry a credential.
 */
export async function postOtlpJson(target: OtlpTarget, body: string): Promise<Error | undefined> {
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    await response.arrayBuffer();
    if (response.status >= 200 && response.status < 300) return undefined;
    return new Error(`OTLP export to ${target.origin} failed: status ${String(response.status)}`);
  } catch (cause) {
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
