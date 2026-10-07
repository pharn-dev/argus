export interface WaterfallRow {
  readonly traceId: string;
  readonly spanId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationNs: number;
  readonly startTimeMs: number;
  readonly offsetPct: number;
  readonly widthPct: number;
  readonly isError: boolean;
  readonly label: string;
}

export interface WaterfallTrace {
  readonly traceId: string;
  readonly startTimeMs: number;
  readonly rows: readonly WaterfallRow[];
}

export interface WaterfallModel {
  readonly rangeStartMs: number;
  readonly rangeEndMs: number;
  readonly traces: readonly WaterfallTrace[];
}

/**
 * Lays the `maxTraces` most recently started traces out as waterfall rows. Pure and DOM-free.
 *
 * The dashboard client embeds this function through `Function.prototype.toString()`, so it must stay
 * self-contained: every helper is declared inside the body, nothing refers to a module-level
 * binding, and the body holds no backtick and no dollar-brace sequence.
 */
export function buildWaterfall(spans: readonly unknown[], maxTraces: number): WaterfallModel {
  if (!Number.isInteger(maxTraces) || maxTraces < 1) {
    throw new RangeError('maxTraces must be a positive integer');
  }

  interface Span {
    traceId: string;
    spanId: string;
    method: string;
    path: string;
    statusCode: number;
    startTimeMs: number;
    durationNs: number;
  }

  function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function compareText(a: string, b: string): number {
    if (a < b) {
      return -1;
    }
    return a > b ? 1 : 0;
  }

  // Group by trace id; a repeated span id within a trace keeps the last copy.
  const byTrace = new Map<string, Map<string, Span>>();
  for (const entry of spans) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const s = entry as Record<string, unknown>;
    if (
      typeof s['traceId'] !== 'string' ||
      typeof s['spanId'] !== 'string' ||
      typeof s['method'] !== 'string' ||
      typeof s['path'] !== 'string' ||
      !isFiniteNumber(s['statusCode']) ||
      !isFiniteNumber(s['startTimeMs']) ||
      !isFiniteNumber(s['durationNs']) ||
      s['durationNs'] < 0
    ) {
      continue;
    }
    const span: Span = {
      traceId: s['traceId'],
      spanId: s['spanId'],
      method: s['method'],
      path: s['path'],
      statusCode: s['statusCode'],
      startTimeMs: s['startTimeMs'],
      durationNs: s['durationNs'],
    };
    let group = byTrace.get(span.traceId);
    if (group === undefined) {
      group = new Map<string, Span>();
      byTrace.set(span.traceId, group);
    }
    group.set(span.spanId, span);
  }

  // Newest trace first, ties broken on trace id; keep the first maxTraces.
  const groups: { traceId: string; startTimeMs: number; spans: Span[] }[] = [];
  for (const [traceId, group] of byTrace) {
    const members = Array.from(group.values()).sort(
      (a, b) => a.startTimeMs - b.startTimeMs || compareText(a.spanId, b.spanId),
    );
    const first = members[0];
    if (first === undefined) {
      continue;
    }
    groups.push({ traceId, startTimeMs: first.startTimeMs, spans: members });
  }
  groups.sort((a, b) => b.startTimeMs - a.startTimeMs || compareText(a.traceId, b.traceId));
  const kept = groups.slice(0, maxTraces);

  // The visible range spans the kept traces only.
  let rangeStartMs = 0;
  let rangeEndMs = 0;
  let seen = false;
  for (const group of kept) {
    for (const span of group.spans) {
      const end = span.startTimeMs + span.durationNs / 1e6;
      if (!seen || span.startTimeMs < rangeStartMs) {
        rangeStartMs = span.startTimeMs;
      }
      if (!seen || end > rangeEndMs) {
        rangeEndMs = end;
      }
      seen = true;
    }
  }
  const rangeMs = rangeEndMs - rangeStartMs;

  const traces: WaterfallTrace[] = kept.map((group) => ({
    traceId: group.traceId,
    startTimeMs: group.startTimeMs,
    rows: group.spans.map((span) => ({
      traceId: span.traceId,
      spanId: span.spanId,
      method: span.method,
      path: span.path,
      statusCode: span.statusCode,
      durationNs: span.durationNs,
      startTimeMs: span.startTimeMs,
      offsetPct: rangeMs > 0 ? ((span.startTimeMs - rangeStartMs) / rangeMs) * 100 : 0,
      widthPct: rangeMs > 0 ? (span.durationNs / 1e6 / rangeMs) * 100 : 0,
      isError: span.statusCode >= 500 && span.statusCode <= 599,
      label:
        span.method +
        ' ' +
        span.path +
        ' ' +
        span.statusCode +
        ' ' +
        (span.durationNs / 1e6).toFixed(1) +
        ' ms',
    })),
  }));

  return { rangeStartMs, rangeEndMs, traces };
}
