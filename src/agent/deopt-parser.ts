/**
 * Pure line consumer for V8 `--trace-deopt` / `--trace-deopt-verbose` output.
 *
 * It reads the two line shapes V8 prints (Node 22 / V8 12.4 and Node 24 print the same
 * ones, differing only in the `<Code TIER>` token):
 *
 *   [bailout (kind: deopt-eager, reason: R): begin. deoptimizing 0x.. <JSFunction NAME (sfi = 0x..)>, 0x.. <Code TIER>, ...]
 *   [marking dependent code 0x.. <Code TIER> (0x.. <SharedFunctionInfo NAME>) (opt id N) for deoptimization, reason: R]
 *
 * In verbose output a `;;; deoptimize at <url:line:col>` line follows a bailout headline
 * and supplies its source position; every other verbose line (frame dumps, `[bailout end.`)
 * is skipped. A line that starts like a deopt line but does not parse is counted
 * (`unparseableLines()`), never thrown on.
 *
 * Lines are matched with index arithmetic and anchored, linear-time checks only, never
 * a backtracking pattern over the line text.
 *
 * Memory is bounded: `events()` keeps the newest `maxEvents` events (older ones are counted
 * by `droppedEvents()`), and a line longer than `maxLineLength` is not parsed (counted as
 * unparseable when it starts like a deopt line, otherwise skipped).
 *
 * This is a parser only: nothing in the agent captures `--trace-deopt` output; the caller
 * feeds it lines.
 */

/** Function name recorded when V8 prints no name for the function. */
export const ANONYMOUS_FUNCTION = '(anonymous)';

/** `kind` of an event built from a `[marking dependent code ...]` line. */
export const DEPENDENT_CODE_KIND = 'dependent-code';

export type DeoptLocation = { scriptUrl: string; line: number; column: number };

export type DeoptEvent = {
  /** V8's bailout kind without the `deopt-` prefix (`eager`, `lazy`, `soft`), or `dependent-code`. */
  kind: string;
  reason: string;
  functionName: string;
  /** The `<Code TIER>` token (`TURBOFAN`, `MAGLEV`, `TURBOFAN_JS`, ...). */
  tier: string;
  /** Source position from the verbose `;;; deoptimize at` line; `null` when none was seen. */
  location: DeoptLocation | null;
};

export type DeoptParser = {
  push(line: string): void;
  /** The newest retained events (at most `maxEvents`), oldest first. */
  events(): DeoptEvent[];
  /** Bailout count per function name, over every bailout seen (not only retained ones). */
  counts(): Map<string, number>;
  unparseableLines(): number;
  /** Integer count of events evicted from `events()` to stay within `maxEvents`. */
  droppedEvents(): number;
};

export type DeoptParserOptions = {
  /** Maximum events retained by `events()`; the oldest is evicted first. Defaults to 1000. */
  maxEvents?: number;
  /** Lines longer than this many characters are not parsed. Defaults to 16384. */
  maxLineLength?: number;
};

export const DEFAULT_DEOPT_MAX_EVENTS = 1000;
export const DEFAULT_DEOPT_MAX_LINE_LENGTH = 16_384;

const BAILOUT_PREFIX = '[bailout (kind: ';
const BAILOUT_END_PREFIX = '[bailout end.';
const POSITION_PREFIX = ';;; deoptimize at ';
const MARKING_PREFIX = '[marking dependent code ';
const KIND_PREFIX = 'deopt-';
const REASON_MARK = ', reason: ';
const REASON_END_MARK = '): begin. deoptimizing ';
const FUNCTION_MARK = '<JSFunction';
const SFI_MARK = ' (sfi = ';
const CODE_MARK = '<Code ';
const SHARED_MARK = '<SharedFunctionInfo';
const MARKING_REASON_MARK = ' for deoptimization, reason: ';

const TIER = /^[A-Za-z0-9_]+$/;
const DIGITS = /^[0-9]+$/;

function parseTier(text: string, from: number): string | null {
  const start = text.indexOf(CODE_MARK, from);
  if (start < 0) return null;
  const tierStart = start + CODE_MARK.length;
  const end = text.indexOf('>', tierStart);
  if (end < 0) return null;
  const tier = text.slice(tierStart, end);
  return TIER.test(tier) ? tier : null;
}

function parseBailout(text: string): DeoptEvent | null {
  const kindStart = BAILOUT_PREFIX.length;
  const kindEnd = text.indexOf(REASON_MARK, kindStart);
  if (kindEnd < 0) return null;
  const rawKind = text.slice(kindStart, kindEnd);
  if (rawKind.length === 0) return null;
  const kind = rawKind.startsWith(KIND_PREFIX) ? rawKind.slice(KIND_PREFIX.length) : rawKind;
  if (kind.length === 0) return null;

  const reasonStart = kindEnd + REASON_MARK.length;
  const reasonEnd = text.indexOf(REASON_END_MARK, reasonStart);
  if (reasonEnd < 0) return null;
  const reason = text.slice(reasonStart, reasonEnd);
  if (reason.length === 0) return null;

  const fnStart = text.indexOf(FUNCTION_MARK, reasonEnd);
  if (fnStart < 0) return null;
  const afterFn = fnStart + FUNCTION_MARK.length;
  const sfiStart = text.indexOf(SFI_MARK, afterFn);
  if (sfiStart < 0) return null;
  const name = text.slice(afterFn, sfiStart).trim();
  const sfiEnd = text.indexOf(')>', sfiStart);
  if (sfiEnd < 0) return null;

  const tier = parseTier(text, sfiEnd);
  if (tier === null) return null;

  return {
    kind,
    reason,
    functionName: name.length > 0 ? name : ANONYMOUS_FUNCTION,
    tier,
    location: null,
  };
}

function parseMarking(text: string): DeoptEvent | null {
  if (!text.endsWith(']')) return null;
  const tier = parseTier(text, MARKING_PREFIX.length);
  if (tier === null) return null;

  const sfiStart = text.indexOf(SHARED_MARK, MARKING_PREFIX.length);
  if (sfiStart < 0) return null;
  const nameStart = sfiStart + SHARED_MARK.length;
  const nameEnd = text.indexOf('>', nameStart);
  if (nameEnd < 0) return null;
  const name = text.slice(nameStart, nameEnd).trim();

  const reasonMark = text.indexOf(MARKING_REASON_MARK, nameEnd);
  if (reasonMark < 0) return null;
  const reason = text.slice(reasonMark + MARKING_REASON_MARK.length, text.length - 1);
  if (reason.length === 0) return null;

  return {
    kind: DEPENDENT_CODE_KIND,
    reason,
    functionName: name.length > 0 ? name : ANONYMOUS_FUNCTION,
    tier,
    location: null,
  };
}

function parsePosition(text: string): DeoptLocation | null {
  const start = POSITION_PREFIX.length;
  if (text.charAt(start) !== '<') return null;
  // The first <...> group is the innermost position; a trailing `inlined at <...>` is ignored.
  const end = text.indexOf('>', start + 1);
  if (end < 0) return null;
  const inner = text.slice(start + 1, end);
  const lastColon = inner.lastIndexOf(':');
  if (lastColon < 1) return null;
  const prevColon = inner.lastIndexOf(':', lastColon - 1);
  if (prevColon < 1) return null;
  const lineText = inner.slice(prevColon + 1, lastColon);
  const columnText = inner.slice(lastColon + 1);
  if (!DIGITS.test(lineText) || !DIGITS.test(columnText)) return null;
  const line = Number.parseInt(lineText, 10);
  const column = Number.parseInt(columnText, 10);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return null;
  return { scriptUrl: inner.slice(0, prevColon), line, column };
}

function copyEvent(event: DeoptEvent): DeoptEvent {
  return { ...event, location: event.location === null ? null : { ...event.location } };
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
  return value;
}

/** Whether a line (already left-trimmed) starts like one of the deopt lines this parser reads. */
function looksLikeDeoptLine(text: string): boolean {
  return (
    text.startsWith('[bailout (') ||
    text.startsWith(POSITION_PREFIX) ||
    text.startsWith('[marking dependent code')
  );
}

export function createDeoptParser(options: DeoptParserOptions = {}): DeoptParser {
  const maxEvents = positiveInteger('maxEvents', options.maxEvents, DEFAULT_DEOPT_MAX_EVENTS);
  const maxLineLength = positiveInteger(
    'maxLineLength',
    options.maxLineLength,
    DEFAULT_DEOPT_MAX_LINE_LENGTH,
  );
  // Ring buffer: `ring[(head + i) % maxEvents]` for i < size, oldest first.
  const ring: DeoptEvent[] = [];
  let head = 0;
  let dropped = 0;
  const counts = new Map<string, number>();
  let unparseable = 0;
  let pending: DeoptEvent | null = null;

  function record(event: DeoptEvent): void {
    if (ring.length < maxEvents) {
      ring.push(event);
      return;
    }
    ring[head] = event;
    head = (head + 1) % maxEvents;
    dropped += 1;
  }

  function retained(): DeoptEvent[] {
    const result: DeoptEvent[] = [];
    for (let i = 0; i < ring.length; i += 1) {
      const event = ring[(head + i) % ring.length];
      if (event !== undefined) result.push(copyEvent(event));
    }
    return result;
  }

  function push(line: string): void {
    const raw = typeof line === 'string' ? line : '';
    if (raw.length > maxLineLength) {
      // Only the start is inspected, so an overlong line costs no more than a normal one.
      if (looksLikeDeoptLine(raw.slice(0, 64).trimStart())) {
        unparseable += 1;
        pending = null;
      }
      return;
    }
    const text = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).trimStart();
    if (text.length === 0) return;

    if (text.startsWith('[bailout (')) {
      const event = parseBailout(text);
      if (event === null) {
        unparseable += 1;
        pending = null;
        return;
      }
      record(event);
      counts.set(event.functionName, (counts.get(event.functionName) ?? 0) + 1);
      pending = event;
      return;
    }

    if (text.startsWith(POSITION_PREFIX)) {
      const location = parsePosition(text);
      if (pending === null || location === null) {
        unparseable += 1;
        return;
      }
      pending.location = location;
      pending = null;
      return;
    }

    if (text.startsWith('[marking dependent code')) {
      pending = null;
      const event = text.startsWith(MARKING_PREFIX) ? parseMarking(text) : null;
      if (event === null) {
        unparseable += 1;
        return;
      }
      record(event);
      return;
    }

    if (text.startsWith(BAILOUT_END_PREFIX)) {
      pending = null;
    }
    // Anything else (frame dumps, program output) is not a deopt line: skipped, not counted.
  }

  return {
    push,
    events: retained,
    counts: () => new Map(counts),
    unparseableLines: () => unparseable,
    droppedEvents: () => dropped,
  };
}
