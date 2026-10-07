import { fork, type ChildProcess } from 'node:child_process';
import { RuleErrorCode, ruleFailure, type RuleRunResult } from './rule-result.js';
import type { RunReply, RunRequest } from './sandbox-protocol.js';

export type SandboxRequest = Omit<RunRequest, 'type' | 'id'>;

export type SandboxProcess = {
  request(req: SandboxRequest, watchdogMs: number): Promise<RuleRunResult>;
  kill(): Promise<void>;
};

type Pending = {
  id: number;
  resolve: (result: RuleRunResult) => void;
  timer: NodeJS.Timeout;
};

const KILL_FALLBACK_MS = 1000;

function isRunReply(value: unknown): value is RunReply {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v['type'] === 'result' && typeof v['id'] === 'number' && typeof v['result'] === 'object';
}

/** The host side of one lazily forked sandbox child; one request in flight at a time. */
export function createSandboxProcess(scriptPath: string): SandboxProcess {
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
      execArgv: ['--no-node-snapshot'],
      serialization: 'json',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    proc.on('message', (message: unknown) => {
      if (proc !== child) {
        return;
      }
      if (!isRunReply(message) || pending === undefined || message.id !== pending.id) {
        process.emitWarning('argus sandbox: ignored an unexpected reply from the sandbox child');
        return;
      }
      settle(message.result);
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
