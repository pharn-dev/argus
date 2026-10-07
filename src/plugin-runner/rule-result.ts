/** Stable error codes for a rule run that did not produce findings. */
export const RuleErrorCode = Object.freeze({
  RULE_THREW: 'ARGUS_RULE_THREW',
  TIMEOUT: 'ARGUS_RULE_TIMEOUT',
  MEMORY_LIMIT: 'ARGUS_RULE_MEMORY_LIMIT',
  COMPILE_ERROR: 'ARGUS_RULE_COMPILE_ERROR',
  ISOLATED_VM_MISSING: 'ARGUS_ISOLATED_VM_MISSING',
  INVALID_RESULT: 'ARGUS_RULE_INVALID_RESULT',
  SANDBOX_CRASHED: 'ARGUS_SANDBOX_CRASHED',
  RUNNER_CLOSED: 'ARGUS_RUNNER_CLOSED',
  INVALID_PARAMETER: 'ARGUS_RULE_INVALID_PARAMETER',
  RULES_DIR_UNREADABLE: 'ARGUS_RULES_DIR_UNREADABLE',
  RULE_FILE_UNREADABLE: 'ARGUS_RULE_FILE_UNREADABLE',
  DUPLICATE_RULE_ID: 'ARGUS_RULE_DUPLICATE_ID',
} as const);

export type RuleErrorCodeValue = (typeof RuleErrorCode)[keyof typeof RuleErrorCode];

/** One finding a rule reported; it identifies its window by that window's `start`. */
export type RuleFinding = { windowStart: number; message: string };

/** Plain JSON data describing the outcome of one rule run. */
export type RuleRunResult =
  | { ok: true; findings: RuleFinding[] }
  | { ok: false; error: { code: RuleErrorCodeValue; message: string } };

export function ruleFailure(code: RuleErrorCodeValue, message: string): RuleRunResult {
  return { ok: false, error: { code, message } };
}

/** Returns the validated findings, or a string reason when the value is not a findings array. */
export function parseFindings(value: unknown): RuleFinding[] | string {
  if (!Array.isArray(value)) {
    return 'the rule must return an array of findings';
  }
  const findings: RuleFinding[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return 'every finding must be an object';
    }
    const { windowStart, message } = item as Record<string, unknown>;
    if (typeof windowStart !== 'number' || !Number.isSafeInteger(windowStart)) {
      return 'every finding needs an integer windowStart';
    }
    if (typeof message !== 'string') {
      return 'every finding needs a string message';
    }
    findings.push({ windowStart, message });
  }
  return findings;
}
