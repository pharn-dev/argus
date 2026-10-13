import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, type MainIo } from './main.js';

const URL_LINE = /^dashboard at http:\/\/127\.0\.0\.1:(\d+)$/;
const TIMEOUT_MS = 15_000;

/** Status code of a GET / sent to the dashboard on `port` with the given `Host` header. */
function statusFor(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host }, timeout: TIMEOUT_MS },
      (res) => {
        res.resume();
        res.on('error', reject);
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`GET / with Host ${host} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

describe('phargus serve: --allowed-host reaches the dashboard Host check', () => {
  it('answers an allowed Host and refuses any other with 421', async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    let onUrl: (port: number) => void = () => undefined;
    const started = new Promise<number>((resolve) => {
      onUrl = resolve;
    });
    const stdin = new PassThrough();
    const io: MainIo = {
      env: {},
      stdin: () => stdin,
      signals,
      write: (text) => {
        lines.push(text);
        const match = URL_LINE.exec(text);
        if (match?.[1] !== undefined) {
          onUrl(Number(match[1]));
        }
      },
      forceExit: (code) => {
        throw new Error(`forced exit ${String(code)}: ${lines.join('\n')}`);
      },
      stdout: () => undefined,
    };

    const exited = main(
      [
        'serve',
        '--port',
        '0',
        '--allowed-host',
        'dash.example',
        '--allowed-host',
        'proxy.example:8443',
      ],
      io,
    );
    const port = await Promise.race([
      started,
      exited.then((code) => {
        throw new Error(`serve exited early with ${String(code)}: ${lines.join('\n')}`);
      }),
    ]);

    try {
      // A bare name is allowed on any port; host:port only exactly.
      expect(await statusFor(port, `dash.example:${String(port)}`)).toBe(200);
      expect(await statusFor(port, 'dash.example')).toBe(200);
      expect(await statusFor(port, 'proxy.example:8443')).toBe(200);
      expect(await statusFor(port, `proxy.example:${String(port)}`)).toBe(421);
      expect(await statusFor(port, `evil.example:${String(port)}`)).toBe(421);
      // The defaults still hold.
      expect(await statusFor(port, `127.0.0.1:${String(port)}`)).toBe(200);
    } finally {
      signals.emit('SIGTERM');
      stdin.end();
    }
    expect(await exited).toBe(0);
  }, 30_000);
});
