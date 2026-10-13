export type DropReporterOptions = {
  /** At most one report per this many milliseconds; drops in between are aggregated. */
  intervalMs: number;
  /** Delivers one report. Must not throw. */
  report: (error: Error) => void;
  /** Builds the report for `count` dropped items. */
  describe: (count: number) => Error;
};

export type DropReporter = {
  /** Records `count` more dropped items; reports now, or arms one timer for the end of the window. */
  add(count: number): void;
  /** Reports any unreported count immediately and cancels the window timer. */
  flushNow(): void;
  /** Cancels the window timer without reporting. */
  dispose(): void;
};

/**
 * Rate-limited, aggregated reporting of dropped items: the first drop is reported at once, further
 * drops within `intervalMs` become one aggregated report at the end of the window, so a burst of
 * drops yields a handful of reports, never one per item and never none. The only timer is
 * `unref()`ed. Counts are integers.
 */
export function createDropReporter(options: DropReporterOptions): DropReporter {
  const { intervalMs, report, describe } = options;
  let unreported = 0;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;

  function clearTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function reportNow(): void {
    clearTimer();
    if (unreported === 0) return;
    const count = unreported;
    unreported = 0;
    lastReportAt = performance.now();
    report(describe(count));
  }

  function add(count: number): void {
    if (count <= 0) return;
    unreported += count;
    if (timer !== undefined) return;
    const remaining = intervalMs - (performance.now() - lastReportAt);
    if (remaining <= 0) {
      reportNow();
      return;
    }
    timer = setTimeout(reportNow, Math.ceil(remaining));
    timer.unref();
  }

  return { add, flushNow: reportNow, dispose: clearTimer };
}
