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
  events(): DeoptEvent[];
  counts(): Map<string, number>;
  unparseableLines(): number;
};

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

export function createDeoptParser(): DeoptParser {
  const events: DeoptEvent[] = [];
  const counts = new Map<string, number>();
  let unparseable = 0;
  let pending: DeoptEvent | null = null;

  function push(line: string): void {
    const raw = typeof line === 'string' ? line : '';
    const text = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).trimStart();
    if (text.length === 0) return;

    if (text.startsWith('[bailout (')) {
      const event = parseBailout(text);
      if (event === null) {
        unparseable += 1;
        pending = null;
        return;
      }
      events.push(event);
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
      events.push(event);
      return;
    }

    if (text.startsWith(BAILOUT_END_PREFIX)) {
      pending = null;
    }
    // Anything else (frame dumps, program output) is not a deopt line: skipped, not counted.
  }

  return {
    push,
    events: () => events.map(copyEvent),
    counts: () => new Map(counts),
    unparseableLines: () => unparseable,
  };
}
