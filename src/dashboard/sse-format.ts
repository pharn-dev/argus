/** One SSE event; JSON.stringify never emits a raw newline, so `data:` is always one line. */
export function formatEvent(event: 'window' | 'alert', payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export const HEARTBEAT = ':heartbeat\n\n';
