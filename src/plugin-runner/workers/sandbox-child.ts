// Sandbox child process entry. Runs one user rule per fresh isolated-vm isolate.
// Erasable TypeScript syntax only (and `import type` only): this file runs from
// source under Node's type stripping as well as from the compiled builds.
import type { RunReply, RunRequest } from '../sandbox-protocol.js';
import type { RuleFinding, RuleRunResult } from '../rule-result.js';

type IvmScript = { run(context: unknown, options: { timeout: number }): Promise<unknown> };
type IvmIsolate = {
  readonly isDisposed: boolean;
  compileScript(code: string): Promise<IvmScript>;
  createContext(): Promise<{
    global: { set(name: string, value: unknown): Promise<void> };
  }>;
  dispose(): void;
};
type IvmModule = { Isolate: new (options: { memoryLimit: number }) => IvmIsolate };

let ivmPromise: Promise<IvmModule> | undefined;

function loadIvm(specifier: string): Promise<IvmModule> {
  if (ivmPromise === undefined) {
    const attempt = (async (): Promise<IvmModule> => {
      const loaded = (await import(specifier)) as { default?: IvmModule } & IvmModule;
      return loaded.default ?? loaded;
    })();
    ivmPromise = attempt;
    attempt.catch(() => {
      // Do not memoise a failed load; the caller reports the error.
      if (ivmPromise === attempt) {
        ivmPromise = undefined;
      }
    });
  }
  return ivmPromise;
}

function failure(code: string, message: string): RuleRunResult {
  return { ok: false, error: { code, message } } as RuleRunResult;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseFindingsLocal(value: unknown): RuleFinding[] | string {
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

async function runRule(request: RunRequest): Promise<RuleRunResult> {
  let ivm: IvmModule;
  try {
    ivm = await loadIvm(request.isolatedVmModule);
  } catch (error) {
    return failure(
      'ARGUS_ISOLATED_VM_MISSING',
      `isolated-vm could not be loaded (${request.isolatedVmModule}: ${messageOf(error)}). ` +
        'argus/plugin-runner needs it: install it with `npm install isolated-vm` ' +
        '(an optional peer dependency of argus, 6.x).',
    );
  }

  const isolate = new ivm.Isolate({ memoryLimit: request.memoryLimitMb });
  try {
    const context = await isolate.createContext();
    await context.global.set('__argusInput', request.windowsJson);
    const code =
      '"use strict"; const __argusRule = (function (windows) {\n' +
      request.source +
      '\n}); JSON.stringify(__argusRule(JSON.parse(__argusInput)));';

    let script: IvmScript;
    try {
      script = await isolate.compileScript(code);
    } catch (error) {
      return failure('ARGUS_RULE_COMPILE_ERROR', messageOf(error));
    }

    const startedAt = process.hrtime.bigint();
    let output: unknown;
    try {
      output = await script.run(context, { timeout: request.timeoutMs });
    } catch (error) {
      const message = messageOf(error);
      if (isolate.isDisposed) {
        return failure(
          'ARGUS_RULE_MEMORY_LIMIT',
          `the rule exceeded the ${request.memoryLimitMb} MB memory limit (${message})`,
        );
      }
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (/timed out/i.test(message) && elapsedMs >= request.timeoutMs) {
        return failure(
          'ARGUS_RULE_TIMEOUT',
          `the rule exceeded the ${request.timeoutMs} ms timeout`,
        );
      }
      return failure('ARGUS_RULE_THREW', message);
    }

    if (typeof output !== 'string') {
      return failure(
        'ARGUS_RULE_INVALID_RESULT',
        'the rule did not return a JSON-serialisable value',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      return failure(
        'ARGUS_RULE_INVALID_RESULT',
        `the rule result is not valid JSON: ${messageOf(error)}`,
      );
    }
    const findings = parseFindingsLocal(parsed);
    if (typeof findings === 'string') {
      return failure('ARGUS_RULE_INVALID_RESULT', findings);
    }
    return { ok: true, findings };
  } catch (error) {
    if (isolate.isDisposed) {
      return failure(
        'ARGUS_RULE_MEMORY_LIMIT',
        `the rule exceeded the ${request.memoryLimitMb} MB memory limit`,
      );
    }
    return failure('ARGUS_RULE_THREW', messageOf(error));
  } finally {
    if (!isolate.isDisposed) {
      isolate.dispose();
    }
  }
}

function isRunRequest(value: unknown): value is RunRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v['type'] === 'run' &&
    typeof v['id'] === 'number' &&
    typeof v['source'] === 'string' &&
    typeof v['windowsJson'] === 'string' &&
    typeof v['timeoutMs'] === 'number' &&
    typeof v['memoryLimitMb'] === 'number' &&
    typeof v['isolatedVmModule'] === 'string'
  );
}

let queue: Promise<void> = Promise.resolve();

process.on('message', (message: unknown) => {
  if (!isRunRequest(message)) {
    process.stderr.write('argus sandbox: ignored a malformed request\n');
    return;
  }
  const request = message;
  queue = queue.then(async () => {
    let result: RuleRunResult;
    try {
      result = await runRule(request);
    } catch (error) {
      result = failure('ARGUS_RULE_THREW', messageOf(error));
    }
    const reply: RunReply = { type: 'result', id: request.id, result };
    if (process.send === undefined) {
      process.stderr.write('argus sandbox: no IPC channel to reply on\n');
      process.exit(1);
      return;
    }
    process.send(reply, (error: Error | null) => {
      if (error !== null) {
        process.stderr.write(`argus sandbox: failed to send reply: ${error.message}\n`);
        process.exit(1);
      }
    });
  });
});

process.on('disconnect', () => {
  process.exit(0);
});

process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`argus sandbox: uncaught exception: ${error.stack ?? error.message}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`argus sandbox: unhandled rejection: ${messageOf(reason)}\n`);
  process.exit(1);
});
