// Test fixture worker: echo, crash or hang on demand. Node core only; erasable TypeScript only.
import { parentPort } from 'node:worker_threads';
import type { TaskReply, TaskRequest } from '../worker-protocol.js';

if (parentPort === null) throw new Error('test-task worker must run in a worker thread');
const port = parentPort;

port.on('message', (request: TaskRequest) => {
  const payload = request.payload as { kind?: unknown } | null;
  const kind = typeof payload === 'object' && payload !== null ? payload.kind : undefined;
  if (kind === 'echo') {
    const reply: TaskReply = { id: request.id, ok: true, value: request.payload };
    port.postMessage(reply);
  } else if (kind === 'crash') {
    throw new Error('test-task worker: crash requested');
  } else if (kind === 'hang') {
    // never replies
  } else {
    const reply: TaskReply = {
      id: request.id,
      ok: false,
      error: { name: 'Error', message: 'test-task worker: unknown kind' },
    };
    port.postMessage(reply);
  }
});
