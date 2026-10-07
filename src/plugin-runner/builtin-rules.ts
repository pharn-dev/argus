import type { RuleDescriptor } from './rule-descriptor.js';
import { assertParamsObject, readIntegerParam } from './rule-parameter-error.js';

/** Ids of the built-in rules. The `argus/` prefix cannot come from a rules-directory file name. */
export const BuiltinRuleId = Object.freeze({
  EVENT_LOOP_LAG: 'argus/event-loop-lag',
  HEAP_GROWTH: 'argus/heap-growth',
  GC_PAUSE_SHARE: 'argus/gc-pause-share',
} as const);

export type EventLoopLagParams = { thresholdNs?: number; windows?: number };
export type HeapGrowthParams = { windows?: number };
export type GcPauseShareParams = { thresholdPerMille?: number };

/** Event-loop max above the threshold for N or more adjacent windows. Reads only `windows` and `params`. */
const EVENT_LOOP_LAG_BODY = `
const findings = [];
let runStart = -1;
for (let i = 0; i <= windows.length; i++) {
  const over = i < windows.length && windows[i].eventLoop.max > params.thresholdNs;
  if (over) {
    if (runStart < 0) runStart = i;
    continue;
  }
  if (runStart >= 0) {
    const length = i - runStart;
    if (length >= params.windows) {
      for (let j = runStart; j < i; j++) {
        findings.push({
          windowStart: windows[j].start,
          message: 'event-loop max ' + windows[j].eventLoop.max + ' ns above ' + params.thresholdNs + ' ns for ' + length + ' consecutive windows',
        });
      }
    }
    runStart = -1;
  }
}
return findings;
`;

/** Heap used strictly rising across N or more adjacent windows. Reads only `windows` and `params`. */
const HEAP_GROWTH_BODY = `
const findings = [];
let runStart = 0;
for (let i = 1; i <= windows.length; i++) {
  const rising = i < windows.length && windows[i].memory.heapUsedLast > windows[i - 1].memory.heapUsedLast;
  if (rising) continue;
  const length = i - runStart;
  if (length >= params.windows) {
    const startBytes = windows[runStart].memory.heapUsedLast;
    for (let j = runStart; j < i; j++) {
      findings.push({
        windowStart: windows[j].start,
        message: 'heap used rose for ' + length + ' consecutive windows: ' + startBytes + ' bytes at run start, ' + windows[j].memory.heapUsedLast + ' bytes here',
      });
    }
  }
  runStart = i;
}
return findings;
`;

/** GC pause above a per-mille share of the window length, in integer math. Reads only `windows` and `params`. */
const GC_PAUSE_SHARE_BODY = `
const findings = [];
for (let i = 0; i < windows.length; i++) {
  const w = windows[i];
  const durationMs = w.end - w.start;
  if (durationMs <= 0) continue;
  const nsPerMille = durationMs * 1000;
  if (w.gc.totalPause > params.thresholdPerMille * nsPerMille) {
    findings.push({
      windowStart: w.start,
      message: 'gc pause ' + w.gc.totalPause + ' ns is ' + Math.floor(w.gc.totalPause / nsPerMille) + ' per-mille of a ' + durationMs + ' ms window, above ' + params.thresholdPerMille + ' per-mille',
    });
  }
}
return findings;
`;

/** Builds a frozen descriptor: the validated parameters as an inert JSON literal, then the fixed body. */
function descriptor(id: string, validated: Record<string, number>, body: string): RuleDescriptor {
  return Object.freeze({ id, source: `const params = ${JSON.stringify(validated)};\n${body}` });
}

/** Flags every window in a run of `windows` or more adjacent windows whose event-loop max exceeds `thresholdNs`. */
export function eventLoopLagRule(params?: EventLoopLagParams): RuleDescriptor {
  const id = BuiltinRuleId.EVENT_LOOP_LAG;
  const given = assertParamsObject(id, params, ['thresholdNs', 'windows']);
  const thresholdNs = readIntegerParam(id, given, 'thresholdNs', 100_000_000, 0);
  const windows = readIntegerParam(id, given, 'windows', 3, 1);
  return descriptor(id, { thresholdNs, windows }, EVENT_LOOP_LAG_BODY);
}

/** Flags every window in a run of `windows` or more adjacent windows with strictly rising heap used. */
export function heapGrowthRule(params?: HeapGrowthParams): RuleDescriptor {
  const id = BuiltinRuleId.HEAP_GROWTH;
  const given = assertParamsObject(id, params, ['windows']);
  const windows = readIntegerParam(id, given, 'windows', 3, 2);
  return descriptor(id, { windows }, HEAP_GROWTH_BODY);
}

/** Flags every window whose GC pause time exceeds `thresholdPerMille` thousandths of the window. */
export function gcPauseShareRule(params?: GcPauseShareParams): RuleDescriptor {
  const id = BuiltinRuleId.GC_PAUSE_SHARE;
  const given = assertParamsObject(id, params, ['thresholdPerMille']);
  const thresholdPerMille = readIntegerParam(id, given, 'thresholdPerMille', 100, 0, 1000);
  return descriptor(id, { thresholdPerMille }, GC_PAUSE_SHARE_BODY);
}
