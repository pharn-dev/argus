import { describe, expect, it } from 'vitest';
import { UsageError, parseServeArgs, type ServeOptions } from './args.js';

function serveOptions(argv: readonly string[], env: NodeJS.ProcessEnv = {}): ServeOptions {
  const parsed = parseServeArgs(argv, env);
  if (parsed.kind !== 'serve') {
    throw new Error(`expected a serve command, got ${parsed.kind}`);
  }
  return parsed.options;
}

describe('phargus serve: --allowed-host parsing', () => {
  it('defaults to no extra hosts', () => {
    expect(serveOptions(['serve']).allowedHosts).toEqual([]);
  });

  it('collects every occurrence in order, bare names and host:port alike', () => {
    expect(
      serveOptions([
        'serve',
        '--allowed-host',
        'dash.example',
        '--allowed-host=192.0.2.10',
        '--allowed-host',
        'proxy.example:8443',
      ]).allowedHosts,
    ).toEqual(['dash.example', '192.0.2.10', 'proxy.example:8443']);
  });

  it('works with a non-loopback --host and a token', () => {
    const options = serveOptions(['serve', '--host', '0.0.0.0', '--allowed-host', 'box.lan'], {
      PHARGUS_TOKEN: 't0ken',
    });
    expect(options.host).toBe('0.0.0.0');
    expect(options.allowedHosts).toEqual(['box.lan']);
  });

  it('does not lift the token requirement off loopback', () => {
    expect(() =>
      parseServeArgs(['serve', '--host', '0.0.0.0', '--allowed-host', 'box.lan'], {}),
    ).toThrow(UsageError);
  });

  it.each([
    ['empty', ''],
    ['whitespace', 'dash example'],
    ['a tab', 'dash\texample'],
    ['a scheme', 'http://dash.example'],
    ['a path', 'dash.example/ui'],
  ])('rejects %s as a usage error with exit code 2', (_label, value) => {
    let caught: unknown;
    try {
      parseServeArgs(['serve', '--allowed-host', value], {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).exitCode).toBe(2);
    expect((caught as UsageError).message).toContain('--allowed-host');
  });

  it('rejects --allowed-host without a value', () => {
    expect(() => parseServeArgs(['serve', '--allowed-host'], {})).toThrow(UsageError);
  });
});
