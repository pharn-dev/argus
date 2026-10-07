import type { CollectorPlaceholder } from '../collector/index.js';

/** Scaffold placeholder — plugin runner lands in a later step. */
export type PluginRunnerPlaceholder = CollectorPlaceholder;

export { createPluginRunner } from './plugin-runner.js';
export type { PluginRunner, PluginRunnerOptions } from './plugin-runner.js';
export { RuleErrorCode } from './rule-result.js';
export type { RuleErrorCodeValue, RuleFinding, RuleRunResult } from './rule-result.js';
export type { RuleDescriptor } from './rule-descriptor.js';
export { RuleParameterError } from './rule-parameter-error.js';
export {
  BuiltinRuleId,
  eventLoopLagRule,
  gcPauseShareRule,
  heapGrowthRule,
} from './builtin-rules.js';
export type { EventLoopLagParams, GcPauseShareParams, HeapGrowthParams } from './builtin-rules.js';
export { loadRulesDirectory } from './rules-directory.js';
export type { RuleLoadFailure, RulesDirectoryResult } from './rules-directory.js';
export { runRules } from './run-rules.js';
export type { RuleResults } from './run-rules.js';
