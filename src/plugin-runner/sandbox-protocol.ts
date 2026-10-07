import type { RuleRunResult } from './rule-result.js';

/** Host to child: run one rule source over the JSON-encoded windows. */
export type RunRequest = {
  type: 'run';
  id: number;
  source: string;
  windowsJson: string;
  timeoutMs: number;
  memoryLimitMb: number;
  isolatedVmModule: string;
  /** Most findings the rule may return; more is ARGUS_RULE_INVALID_RESULT. */
  maxFindings: number;
  /** Most bytes of JSON the rule's result may serialize to; more is ARGUS_RULE_INVALID_RESULT. */
  maxResultBytes: number;
};

/** Child to host: the outcome of the request with the same id. */
export type RunReply = { type: 'result'; id: number; result: RuleRunResult };
