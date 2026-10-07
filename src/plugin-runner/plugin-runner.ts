import type { AggregatedWindow } from '../collector/index.js';
import { resolveChildScript } from './child-script.js';
import { RuleErrorCode, ruleFailure, type RuleRunResult } from './rule-result.js';
import { createSandboxProcess, type SandboxProcess } from './sandbox-process.js';

export type PluginRunnerOptions = {
  /** Wall-clock limit for one rule run, in ms. Default 1000. */
  timeoutMs?: number;
  /** Memory limit for the rule's isolate, in MB (minimum 8). Default 64. */
  memoryLimitMb?: number;
  /**
   * Module specifier the sandbox child loads `isolated-vm` from. Default `'isolated-vm'`.
   * Exists as a test seam: pointing it at a specifier that does not resolve exercises the
   * "isolated-vm is not installed" path.
   */
  isolatedVmModule?: string;
  /**
   * Most findings one rule run may return; a rule returning more fails with
   * ARGUS_RULE_INVALID_RESULT. Default 10 000.
   */
  maxFindings?: number;
  /**
   * Most bytes of JSON one rule's result may serialize to; a larger result fails with
   * ARGUS_RULE_INVALID_RESULT before it leaves the sandbox. Default 1 MiB.
   */
  maxResultBytes?: number;
};

export type PluginRunner = {
  /** Runs a rule (a function body receiving `windows`) in the sandbox. Never rejects. */
  run(source: string, windows: readonly AggregatedWindow[]): Promise<RuleRunResult>;
  /** Stops the sandbox. Idempotent. */
  close(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_MEMORY_LIMIT_MB = 64;
const MIN_MEMORY_LIMIT_MB = 8;
const WATCHDOG_SLACK_MS = 1000;
const DEFAULT_MAX_FINDINGS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

export function createPluginRunner(options: PluginRunnerOptions = {}): PluginRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const isolatedVmModule = options.isolatedVmModule ?? 'isolated-vm';
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(memoryLimitMb) || memoryLimitMb < MIN_MEMORY_LIMIT_MB) {
    throw new RangeError(`memoryLimitMb must be a safe integer of at least ${MIN_MEMORY_LIMIT_MB}`);
  }
  if (typeof isolatedVmModule !== 'string' || isolatedVmModule.length === 0) {
    throw new TypeError('isolatedVmModule must be a non-empty string');
  }
  if (!Number.isSafeInteger(maxFindings) || maxFindings <= 0) {
    throw new RangeError('maxFindings must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0) {
    throw new RangeError('maxResultBytes must be a positive safe integer');
  }

  let sandbox: SandboxProcess | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function runOnce(
    source: string,
    windows: readonly AggregatedWindow[],
  ): Promise<RuleRunResult> {
    if (closed) {
      return ruleFailure(RuleErrorCode.RUNNER_CLOSED, 'the plugin runner is closed');
    }
    if (typeof source !== 'string') {
      return ruleFailure(RuleErrorCode.COMPILE_ERROR, 'the rule source must be a string');
    }
    let windowsJson: string;
    try {
      windowsJson = JSON.stringify(windows);
    } catch (error) {
      return ruleFailure(
        RuleErrorCode.INVALID_RESULT,
        `the input windows are not JSON-serialisable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof windowsJson !== 'string') {
      return ruleFailure(
        RuleErrorCode.INVALID_RESULT,
        'the input windows are not JSON-serialisable',
      );
    }
    if (sandbox === undefined) {
      const script = resolveChildScript();
      if (script instanceof Error) {
        return ruleFailure(RuleErrorCode.SANDBOX_CRASHED, script.message);
      }
      sandbox = createSandboxProcess(script, { maxFindings, maxResultBytes });
    }
    return sandbox.request(
      {
        source,
        windowsJson,
        timeoutMs,
        memoryLimitMb,
        isolatedVmModule,
        maxFindings,
        maxResultBytes,
      },
      timeoutMs + WATCHDOG_SLACK_MS,
    );
  }

  function run(source: string, windows: readonly AggregatedWindow[]): Promise<RuleRunResult> {
    const next = queue.then(async () => {
      try {
        return await runOnce(source, windows);
      } catch (error) {
        return ruleFailure(
          RuleErrorCode.SANDBOX_CRASHED,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    queue = next;
    return next;
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      closed = true;
      try {
        await sandbox?.kill();
      } catch (error) {
        process.emitWarning(
          `argus plugin-runner: closing the sandbox failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return closing;
  }

  return { run, close };
}
