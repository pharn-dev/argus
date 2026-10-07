import { RuleErrorCode } from './rule-result.js';

/** Short, bounded description of a rejected value for an error message. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

/** Thrown when a built-in rule is configured with a parameter it cannot accept. */
export class RuleParameterError extends Error {
  readonly code = RuleErrorCode.INVALID_PARAMETER;
  readonly ruleId: string;
  readonly parameter: string;

  constructor(ruleId: string, parameter: string, problem: string, value: unknown) {
    super(
      `built-in rule "${ruleId}": parameter "${parameter}" ${problem}, got ${describeValue(value)}`,
    );
    this.name = 'RuleParameterError';
    this.ruleId = ruleId;
    this.parameter = parameter;
  }
}

/** Returns the parameters as a plain object, rejecting non-objects and any unknown key. */
export function assertParamsObject(
  ruleId: string,
  params: unknown,
  allowedNames: readonly string[],
): Record<string, unknown> {
  if (params === undefined) {
    return {};
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new RuleParameterError(ruleId, 'params', 'must be a plain object', params);
  }
  for (const key of Object.keys(params)) {
    if (!allowedNames.includes(key)) {
      throw new RuleParameterError(
        ruleId,
        key,
        `is not a known parameter (expected one of ${allowedNames.join(', ')})`,
        (params as Record<string, unknown>)[key],
      );
    }
  }
  return params as Record<string, unknown>;
}

/** Reads one integer parameter: absent gives the default, anything else must be a safe integer in range. */
export function readIntegerParam(
  ruleId: string,
  params: Record<string, unknown>,
  name: string,
  defaultValue: number,
  min: number,
  max?: number,
): number {
  if (!Object.prototype.hasOwnProperty.call(params, name) || params[name] === undefined) {
    return defaultValue;
  }
  const value = params[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RuleParameterError(ruleId, name, 'must be a safe integer', value);
  }
  if (value < min) {
    throw new RuleParameterError(ruleId, name, `must be at least ${min}`, value);
  }
  if (max !== undefined && value > max) {
    throw new RuleParameterError(ruleId, name, `must be at most ${max}`, value);
  }
  return value;
}
