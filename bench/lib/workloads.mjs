// Request handlers the target servers run. Each one is a small, fixed amount of a different kind of
// work, so the agent's cost shows up against a known baseline.
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const WORKLOADS = ['trivial', 'promise', 'cpu', 'stream'];

const PROMISE_STEPS = 20;
const CPU_ITERATIONS = 20_000;
const STREAM_CHUNKS = 4;
const CHUNK = Buffer.alloc(1024, 0x61);

async function step(n) {
  return n + 1;
}

/** Respond immediately. */
function trivial(_req, res) {
  res.end('ok');
}

/** A chain of awaited promises: the AsyncLocalStorage propagation cost per await. */
async function promise(_req, res) {
  let n = 0;
  for (let i = 0; i < PROMISE_STEPS; i += 1) n = await step(n);
  res.end(String(n));
}

/** Small synchronous integer work. */
function cpu(_req, res) {
  let x = 0;
  for (let i = 0; i < CPU_ITERATIONS; i += 1) x = (Math.imul(x, 31) + i) | 0;
  res.end(String(x));
}

function flipCase() {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const out = Buffer.allocUnsafe(chunk.length);
      for (let i = 0; i < chunk.length; i += 1) out[i] = chunk[i] ^ 0x20;
      callback(null, out);
    },
  });
}

/** A few KiB through a Transform into the response, via stream/promises pipeline(). */
async function stream(_req, res) {
  res.setHeader('content-type', 'application/octet-stream');
  const chunks = Array.from({ length: STREAM_CHUNKS }, () => CHUNK);
  await pipeline(Readable.from(chunks), flipCase(), res);
}

/**
 * A Writable that stalls: 4 KiB into a 1 KiB highWaterMark sink that completes each write on the
 * next turn, so write() returns false and the agent's backpressure probe sees a stall and a drain.
 */
async function stall(_req, res) {
  const sink = new Writable({
    highWaterMark: 1024,
    write(_chunk, _encoding, callback) {
      setImmediate(callback);
    },
  });
  await pipeline(Readable.from(Array.from({ length: STREAM_CHUNKS }, () => CHUNK)), sink);
  res.end('stalled');
}

const HANDLERS = { trivial, promise, cpu, stream, stall };

/**
 * Wrap a workload as an http request listener. A failure answers 500 (or destroys a response
 * already started) and is passed to `onError`; it is never swallowed.
 */
export function createHandler(workload, onError) {
  const handler = HANDLERS[workload];
  if (handler === undefined) throw new Error(`unknown workload ${JSON.stringify(workload)}`);
  return (req, res) => {
    let result;
    try {
      result = handler(req, res);
    } catch (err) {
      fail(res, err, onError);
      return;
    }
    if (result instanceof Promise) result.catch((err) => fail(res, err, onError));
  };
}

function fail(res, err, onError) {
  onError(err);
  if (res.headersSent) {
    res.destroy();
  } else {
    res.statusCode = 500;
    res.end();
  }
}
