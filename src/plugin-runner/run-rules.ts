import type { AggregatedWindow } from '../collector/index.js';
import type { PluginRunner } from './plugin-runner.js';
import type { RuleDescriptor } from './rule-descriptor.js';
import { RuleErrorCode, ruleFailure } from './rule-result.js';
import type { RuleRunResult } from './rule-result.js';

/** The outcome of every rule, keyed by rule id. */
export type RuleResults = Record<string, RuleRunResult>;

function hasStringId(rule: unknown): rule is RuleDescriptor {
  return (
    typeof rule === 'object' &&
    rule !== null &&
    typeof (rule as { id?: unknown }).id === 'string' &&
    typeof (rule as { source?: unknown }).source === 'string'
  );
}

/**
 * Runs each rule sequentially on the caller's runner and returns one result per rule id.
 * A duplicate id fails every copy; one rule failing never stops the others. Never rejects.
 * The caller creates and closes the runner.
 */
export async function runRules(
  runner: PluginRunner,
  rules: readonly RuleDescriptor[],
  windows: readonly AggregatedWindow[],
): Promise<RuleResults> {
  const counts = new Map<string, number>();
  rules.forEach((rule, index) => {
    if (!hasStringId(rule)) {
      process.emitWarning(
        `rule at index ${index} has no string id and string source and was skipped`,
        'ArgusRuleWarning',
      );
      return;
    }
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
  });

  const entries: [string, RuleRunResult][] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!hasStringId(rule) || seen.has(rule.id)) {
      continue;
    }
    seen.add(rule.id);
    if ((counts.get(rule.id) ?? 0) > 1) {
      entries.push([
        rule.id,
        ruleFailure(
          RuleErrorCode.DUPLICATE_RULE_ID,
          `rule id "${rule.id}" was given ${counts.get(rule.id)} times; none of them ran`,
        ),
      ]);
      continue;
    }
    try {
      entries.push([rule.id, await runner.run(rule.source, windows)]);
    } catch (cause) {
      entries.push([
        rule.id,
        ruleFailure(
          RuleErrorCode.SANDBOX_CRASHED,
          `the runner failed unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      ]);
    }
  }
  return Object.fromEntries(entries);
}
