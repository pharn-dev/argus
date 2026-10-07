import type { CollectorPlaceholder } from '../collector/index.js';

/** Scaffold placeholder — plugin runner lands in a later step. */
export type PluginRunnerPlaceholder = CollectorPlaceholder;

export { createPluginRunner } from './plugin-runner.js';
export type { PluginRunner, PluginRunnerOptions } from './plugin-runner.js';
export { RuleErrorCode } from './rule-result.js';
export type { RuleErrorCodeValue, RuleFinding, RuleRunResult } from './rule-result.js';
