// Child-side IPC: typed request handlers that always answer, with an 'error' reply on failure.
import { describe } from './common.mjs';

/** Send one message to the parent. Rejects if the channel is gone. */
export function send(message) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('this script must be started by the harness (no IPC channel)'));
      return;
    }
    process.send(message, (err) => (err ? reject(err) : resolve()));
  });
}

/** A failure the child cannot report over IPC: write it to stderr and exit non-zero. */
export function die(err) {
  process.stderr.write(`[bench child] ${describe(err)}\n`);
  process.exit(1);
}

/**
 * Dispatch parent messages `{ type }` to `handlers[type]`. A handler's resolved value (if any) is
 * sent back; a throw is sent back as `{ type: 'error', message }`.
 */
export function serve(handlers) {
  process.on('message', (message) => {
    const type = message !== null && typeof message === 'object' ? message.type : undefined;
    const handler = typeof type === 'string' ? handlers[type] : undefined;
    if (handler === undefined) {
      send({ type: 'error', message: `unknown request ${JSON.stringify(type)}` }).catch(die);
      return;
    }
    Promise.resolve()
      .then(() => handler(message))
      .then(
        (reply) => (reply === undefined ? undefined : send(reply)),
        (err) => send({ type: 'error', message: describe(err) }),
      )
      .catch(die);
  });
}
