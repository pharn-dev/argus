/** Reports malformed-request errors without letting an unauthenticated client flood the sink. */
export type ClientErrorReporter = {
  record(error: Error): void;
  /** Reports any suppressed errors now and stops the timer. */
  close(): void;
};

/**
 * Passes the first error of each `intervalMs` window to `report` and counts the rest; when the
 * window ends, one summary reports how many were suppressed, so nothing is dropped silently.
 * A burst therefore costs at most two reports per window, however many requests it holds.
 */
export function createClientErrorReporter(
  report: (error: Error) => void,
  intervalMs: number,
): ClientErrorReporter {
  let windowStart = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  let lastMessage = '';
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    timer = undefined;
    if (suppressed === 0) {
      return;
    }
    const count = suppressed;
    suppressed = 0;
    windowStart = performance.now();
    report(
      new Error(
        `${count} more malformed client request(s) suppressed in the last ${intervalMs} ms (last: ${lastMessage})`,
      ),
    );
  };

  return {
    record(error: Error): void {
      const now = performance.now();
      if (timer === undefined && now - windowStart >= intervalMs) {
        windowStart = now;
        report(error);
        return;
      }
      suppressed += 1;
      lastMessage = error.message;
      if (timer === undefined) {
        timer = setTimeout(flush, Math.max(0, windowStart + intervalMs - now));
        timer.unref();
      }
    },
    close(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      flush();
    },
  };
}
