// SSE clients against the dashboard: `concurrency` loops that connect to /events, read for a short
// random time and disconnect, plus `stalled` clients that connect at the start and never read
// until stop() (a background tab, a stuck proxy). A stalled client must cost bounded memory on the
// server, and once everything has hung up the dashboard must be back to zero clients.
import http from 'node:http';

const HOST = '127.0.0.1';
const MIN_HOLD_MS = 20;
const MAX_HOLD_MS = 300;
const STUCK_MS = 10_000;

/**
 * @param {{ port: number, concurrency: number, stalled: number }} options
 */
export function startSseChurn({ port, concurrency, stalled }) {
  let stopped = false;
  const stats = { cycles: 0, stalled: 0, bytes: 0, errors: 0, firstError: undefined };

  const recordError = (err) => {
    stats.errors += 1;
    stats.firstError ??= err instanceof Error ? err.message : String(err);
  };

  /**
   * Connect one client. With `holdMs` it reads for that long and hangs up; without, it never reads
   * and stays until `hangUp()`. `closed` resolves once the connection is gone.
   */
  function client({ holdMs, read }) {
    let ours = false; // set once we hang up ourselves: errors after that are the hang-up
    let timer;
    const req = http.get({ host: HOST, port, path: '/events', agent: false }, (res) => {
      if (res.statusCode !== 200) recordError(new Error(`/events HTTP ${res.statusCode}`));
      if (read) {
        res.on('data', (chunk) => {
          stats.bytes += chunk.length;
        });
      } else {
        res.pause();
      }
      res.on('error', (err) => {
        if (!ours) recordError(err);
      });
      if (holdMs !== undefined) timer = setTimeout(hangUp, holdMs);
    });
    function hangUp() {
      ours = true;
      req.destroy();
    }
    req.on('error', (err) => {
      if (!ours) recordError(err);
    });
    if (read) {
      // A reading client always receives events or heartbeats; silence means the server is stuck.
      req.setTimeout(STUCK_MS, () => {
        req.destroy(new Error(`/events client idle for ${STUCK_MS} ms`));
      });
    }
    const closed = new Promise((resolve) => {
      req.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { closed, hangUp };
  }

  async function churnLoop() {
    while (!stopped) {
      const holdMs = MIN_HOLD_MS + Math.floor(Math.random() * (MAX_HOLD_MS - MIN_HOLD_MS));
      await client({ holdMs, read: true }).closed;
      stats.cycles += 1;
    }
  }

  const stuck = Array.from({ length: stalled }, () => client({ read: false }));
  stats.stalled = stuck.length;
  const loops = Array.from({ length: concurrency }, () => churnLoop());

  return {
    stats: () => ({ ...stats }),
    async stop() {
      stopped = true;
      for (const c of stuck) c.hangUp();
      await Promise.all([...loops, ...stuck.map((c) => c.closed)]);
      return { ...stats };
    },
  };
}
