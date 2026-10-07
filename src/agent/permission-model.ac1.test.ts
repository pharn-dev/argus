import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const RELATIVE_PATH = join('argus-ac1-out', 'samples.ndjson');

/** The descriptor `process.permission` had before a stub, restored after each test. */
let savedDescriptor: PropertyDescriptor | undefined;
let stubbed = false;

function stubPermission(value: unknown): void {
  savedDescriptor = Object.getOwnPropertyDescriptor(process, 'permission');
  stubbed = true;
  Object.defineProperty(process, 'permission', {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

afterEach(() => {
  if (!stubbed) return;
  stubbed = false;
  if (savedDescriptor === undefined) {
    Reflect.deleteProperty(process, 'permission');
  } else {
    Object.defineProperty(process, 'permission', savedDescriptor);
  }
  savedDescriptor = undefined;
});

describe('agent permission helper — AC-1', () => {
  it('AC-1: without the permission model the helper reports it inactive and the check is allowed; with a denying stub it is active, has() gets the scope and the absolute path, and the check is denied', async () => {
    const { isPermissionModelEnabled, checkPermission } = await import('./index.js');

    // Without the permission model (vitest runs without --permission).
    expect(
      (process as unknown as { permission?: unknown }).permission,
      'the test process runs without --permission',
    ).toBeUndefined();
    expect(isPermissionModelEnabled(), 'inactive without the permission model').toBe(false);
    const inactive = checkPermission('fs.write', RELATIVE_PATH);
    expect(inactive.allowed, 'allowed without the permission model').toBe(true);

    // With a stubbed process.permission whose has() records its arguments and denies.
    const calls: unknown[][] = [];
    stubPermission({
      has: (...args: unknown[]): boolean => {
        calls.push(args);
        return false;
      },
    });

    expect(isPermissionModelEnabled(), 'active with process.permission present').toBe(true);
    const denied = checkPermission('fs.write', RELATIVE_PATH);
    expect(denied.allowed, 'denied when has() returns false').toBe(false);

    const absolute = resolve(RELATIVE_PATH);
    expect(isAbsolute(absolute)).toBe(true);
    expect(calls.length, 'has() was called').toBeGreaterThanOrEqual(1);
    const last = calls[calls.length - 1] as unknown[];
    expect(last[0], 'has() received the scope').toBe('fs.write');
    expect(last[1], 'has() received the absolute form of the relative path').toBe(absolute);
    expect(denied.scope).toBe('fs.write');
    expect(denied.resource).toBe(absolute);
  });

  it('AC-1: the typed permission error from the agent entrypoint is an Error exposing the denied scope and resource as given', async () => {
    const { ArgusPermissionError } = await import('./index.js');

    const err: unknown = new ArgusPermissionError('fs.write', '/abs/x');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ArgusPermissionError);
    expect((err as { scope: unknown }).scope).toBe('fs.write');
    expect((err as { resource: unknown }).resource).toBe('/abs/x');
    expect(typeof (err as Error).message).toBe('string');
    expect((err as Error).message.length).toBeGreaterThan(0);
  });
});
