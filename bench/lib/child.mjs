// Parent-side handle on a forked harness process: IPC request/reply with timeouts, captured
// stderr, and an `exited` promise. Every failure surfaces as a rejection; nothing is swallowed.
import { fork } from 'node:child_process';

const STDERR_LIMIT = 64 * 1024;

/**
 * Fork `file` with an IPC channel.
 * @param {string} file absolute path of the child script
 * @param {{ execArgv?: string[], env: NodeJS.ProcessEnv, cwd: string, stdin?: 'ignore' | 'pipe', stdout?: 'ignore' | 'pipe' }} options
 */
export function forkChild(file, options) {
  const child = fork(file, [], {
    execArgv: options.execArgv ?? [],
    env: options.env,
    cwd: options.cwd,
    stdio: [options.stdin ?? 'ignore', options.stdout ?? 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk;
  });
  let spawnError;
  let exitInfo;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once('error', (err) => {
      spawnError = err;
      // A child that never started has no pid and never emits 'exit'.
      if (child.pid === undefined) resolve({ code: null, signal: null, error: err });
    });
  });

  /**
   * Send `message` (unless null) and wait for a reply whose `type` is `expect`. A reply of type
   * 'error', an exit, or the timeout rejects.
   */
  function request(message, expect, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.off('message', onMessage);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`no "${expect}" reply within ${timeoutMs} ms; stderr: ${stderr}`)),
        );
      }, timeoutMs);
      const onMessage = (reply) => {
        if (reply === null || typeof reply !== 'object') return;
        if (reply.type === 'error') {
          finish(() => reject(new Error(`child reported: ${String(reply.message)}`)));
        } else if (reply.type === expect) {
          finish(() => resolve(reply));
        }
      };
      child.on('message', onMessage);
      void exited.then((info) =>
        finish(() =>
          reject(
            new Error(
              `child exited (code ${String(info.code)}, signal ${String(info.signal)}) before "${expect}"` +
                `${spawnError === undefined ? '' : `: ${spawnError.message}`}; stderr: ${stderr}`,
            ),
          ),
        ),
      );
      if (message !== null) {
        child.send(message, (err) => {
          if (err) finish(() => reject(err));
        });
      }
    });
  }

  /** Resolve with the exit info, or with `undefined` if the child is still alive after `ms`. */
  async function waitExit(ms) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
      return await Promise.race([exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** SIGKILL the child if it is still running, and wait for it to go. */
  async function kill() {
    if (exitInfo === undefined && child.pid !== undefined) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  return {
    child,
    exited,
    request,
    waitExit,
    kill,
    stderr: () => stderr,
    send(message) {
      return new Promise((resolve, reject) => {
        child.send(message, (err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
