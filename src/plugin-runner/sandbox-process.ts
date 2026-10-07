import { fork, type ChildProcess } from 'node:child_process';
import { RuleErrorCode, ruleFailure, type RuleFinding, type RuleRunResult } from './rule-result.js';
import type { RunRequest } from './sandbox-protocol.js';

export type SandboxRequest = Omit<RunRequest, 'type' | 'id'>;

export type SandboxProcess = {
  request(req: SandboxRequest, watchdogMs: number): Promise<RuleRunResult>;
  kill(): Promise<void>;
};

export type SandboxProcessOptions = {
  /** Most findings a reply may carry; a larger reply is turned into ARGUS_RULE_INVALID_RESULT. */
  maxFindings: number;
  /** Most characters of finding messages a reply may carry, same treatment. */
  maxResultBytes: number;
  /** The host flags the child's permissions are derived from. Default `process.execArgv`. */
  hostExecArgv?: readonly string[];
};

type Pending = {
  id: number;
  resolve: (result: RuleRunResult) => void;
  timer: NodeJS.Timeout;
};

const KILL_FALLBACK_MS = 1000;
const ERROR_CODES: ReadonlySet<string> = new Set(Object.values(RuleErrorCode));

/**
 * The child's execArgv. `--no-node-snapshot` is required by isolated-vm. The host's Permission
 * Model flags (`--permission`, its pre-22.13 name `--experimental-permission`, and every
 * `--allow-*` grant) are forwarded so the sandbox is never less constrained than the host.
 */
export function sandboxExecArgv(hostExecArgv: readonly string[] = process.execArgv): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < hostExecArgv.length; index += 1) {
    const token = hostExecArgv[index] ?? '';
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    const isPermissionFlag =
      name === '--permission' ||
      name === '--experimental-permission' ||
      name.startsWith('--allow-');
    if (!isPermissionFlag) continue;
    forwarded.push(token);
    const next = hostExecArgv[index + 1];
    // A grant given as `--allow-fs-read /dir` carries its value in the next token.
    if (equals < 0 && name.startsWith('--allow-') && next !== undefined && !next.startsWith('-')) {
      forwarded.push(next);
      index += 1;
    }
  }
  return ['--no-node-snapshot', ...forwarded];
}

type RawReply = { type: 'result'; id: number; result: unknown };

function isRawReply(value: unknown): value is RawReply {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v['type'] === 'result' && typeof v['id'] === 'number' && Number.isSafeInteger(v['id']);
}

/** Re-validates the child's result: shape, error code, finding count and message volume. */
function checkResult(value: unknown, options: SandboxProcessOptions): RuleRunResult {
  const malformed = (why: string): RuleRunResult =>
    ruleFailure(RuleErrorCode.INVALID_RESULT, `the sandbox child sent an invalid result: ${why}`);
  if (typeof value !== 'object' || value === null) {
    return malformed('not an object');
  }
  const result = value as { ok?: unknown; findings?: unknown; error?: unknown };
  if (result.ok === false) {
    const error = result.error as { code?: unknown; message?: unknown } | null | undefined;
    if (
      typeof error !== 'object' ||
      error === null ||
      typeof error.code !== 'string' ||
      !ERROR_CODES.has(error.code) ||
      typeof error.message !== 'string'
    ) {
      return malformed('the failure has no known code and string message');
    }
    return value as RuleRunResult;
  }
  if (result.ok !== true || !Array.isArray(result.findings)) {
    return malformed('neither a failure nor a findings array');
  }
  if (result.findings.length > options.maxFindings) {
    return malformed(
      `${String(result.findings.length)} findings, over the limit of ${String(options.maxFindings)}`,
    );
  }
  const findings: RuleFinding[] = [];
  let characters = 0;
  for (const item of result.findings as unknown[]) {
    const finding = item as { windowStart?: unknown; message?: unknown } | null;
    if (
      typeof finding !== 'object' ||
      finding === null ||
      typeof finding.windowStart !== 'number' ||
      !Number.isSafeInteger(finding.windowStart) ||
      typeof finding.message !== 'string'
    ) {
      return malformed('a finding is not { windowStart: integer, message: string }');
    }
    characters += finding.message.length;
    if (characters > options.maxResultBytes) {
      return malformed(`finding messages exceed ${String(options.maxResultBytes)} characters`);
    }
    findings.push({ windowStart: finding.windowStart, message: finding.message });
  }
  return { ok: true, findings };
}

/** The host side of one lazily forked sandbox child; one request in flight at a time. */
export function createSandboxProcess(
  scriptPath: string,
  options: SandboxProcessOptions,
): SandboxProcess {
  const execArgv = sandboxExecArgv(options.hostExecArgv);
  let child: ChildProcess | undefined;
  let pending: Pending | undefined;
  let nextId = 0;
  let closed = false;

  function settle(result: RuleRunResult): void {
    const current = pending;
    if (current === undefined) {
      return;
    }
    pending = undefined;
    clearTimeout(current.timer);
    child?.unref();
    child?.channel?.unref();
    current.resolve(result);
  }

  function start(): ChildProcess {
    const proc = fork(scriptPath, [], {
      execArgv,
      serialization: 'json',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    proc.on('message', (message: unknown) => {
      if (proc !== child) {
        return;
      }
      if (!isRawReply(message) || pending === undefined || message.id !== pending.id) {
        process.emitWarning('argus sandbox: ignored an unexpected reply from the sandbox child');
        return;
      }
      settle(checkResult(message.result, options));
    });
    proc.on('error', (error: Error) => {
      onChildGone(proc, `the sandbox child errored: ${error.message}`);
    });
    proc.on('exit', (code, signal) => {
      onChildGone(
        proc,
        `the sandbox child exited (code ${String(code)}, signal ${String(signal)})`,
      );
    });
    proc.unref();
    proc.channel?.unref();
    return proc;
  }

  function onChildGone(proc: ChildProcess, reason: string): void {
    if (proc !== child) {
      return;
    }
    child = undefined;
    if (pending !== undefined) {
      settle(ruleFailure(RuleErrorCode.SANDBOX_CRASHED, reason));
    } else if (!closed) {
      process.emitWarning(`argus sandbox: ${reason} while idle`);
    }
  }

  function request(req: SandboxRequest, watchdogMs: number): Promise<RuleRunResult> {
    if (closed) {
      return Promise.resolve(
        ruleFailure(RuleErrorCode.RUNNER_CLOSED, 'the plugin runner is closed'),
      );
    }
    return new Promise<RuleRunResult>((resolve) => {
      nextId += 1;
      const id = nextId;
      let proc: ChildProcess;
      try {
        child ??= start();
        proc = child;
      } catch (error) {
        resolve(
          ruleFailure(
            RuleErrorCode.SANDBOX_CRASHED,
            `could not start the sandbox child: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      const timer = setTimeout(() => {
        settle(
          ruleFailure(
            RuleErrorCode.TIMEOUT,
            `the sandbox did not answer within ${watchdogMs} ms and was killed`,
          ),
        );
        child = undefined;
        proc.kill('SIGKILL');
      }, watchdogMs);
      pending = { id, resolve, timer };
      proc.ref();
      proc.channel?.ref();
      const message: RunRequest = { type: 'run', id, ...req };
      proc.send(message, (error: Error | null) => {
        if (error !== null) {
          onChildGone(proc, `could not send the request to the sandbox child: ${error.message}`);
          proc.kill('SIGKILL');
        }
      });
    });
  }

  function kill(): Promise<void> {
    closed = true;
    settle(ruleFailure(RuleErrorCode.RUNNER_CLOSED, 'the plugin runner was closed during the run'));
    const proc = child;
    child = undefined;
    if (proc === undefined || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        proc.kill('SIGKILL');
      }, KILL_FALLBACK_MS);
      proc.once('exit', () => {
        clearTimeout(fallback);
        resolve();
      });
      proc.ref();
      if (proc.connected) {
        proc.disconnect();
      }
    });
  }

  return { request, kill };
}
