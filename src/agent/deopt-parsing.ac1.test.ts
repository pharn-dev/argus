import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SHA-256 of each supplied capture, as pinned in pharn/features/deopt-parsing/PLAN.md Steps.
// A fixture that is altered, trimmed or re-wrapped turns these tests red.
const FIXTURE_SHA256: Record<string, string> = {
  'node22.txt': 'b7907407ed4ff66e3175644da4aa2994863689fa6f4ab3731aa6cb0d6fb2948d',
  'node24.txt': 'c8163b7f063044f9f04b21b8e8efe971e62eece12a70430ec90a30d495542744',
};

function readFixture(name: string): string {
  const path = fileURLToPath(new URL(`./__fixtures__/deopt/${name}`, import.meta.url));
  const bytes = readFileSync(path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  expect(digest, `${name} matches its pinned SHA-256`).toBe(FIXTURE_SHA256[name]);
  return bytes.toString('utf8');
}

type ExpectedEvent = { functionName: string | 'ANON'; reason: string };

async function parseFixture(name: string): Promise<{
  events: unknown[];
  counts: Map<string, number>;
  anonymous: string;
}> {
  const { createDeoptParser, ANONYMOUS_FUNCTION } = await import('./index.js');
  const text = readFixture(name);
  const parser = createDeoptParser();
  for (const line of text.split('\n')) parser.push(line);
  return { events: parser.events(), counts: parser.counts(), anonymous: ANONYMOUS_FUNCTION };
}

function expectBailoutEvents(
  events: unknown[],
  anonymous: string,
  expected: ExpectedEvent[],
  label: string,
): void {
  expect(typeof anonymous, 'ANONYMOUS_FUNCTION is a string').toBe('string');
  expect(anonymous.length, 'ANONYMOUS_FUNCTION is non-empty').toBeGreaterThan(0);
  expect(events, `${label} event count`).toHaveLength(expected.length);
  events.forEach((raw, i) => {
    const event = raw as Record<string, unknown>;
    const want = expected[i]!;
    expect(event['kind'], `${label} event ${i} kind`).toBe('eager');
    expect(typeof event['reason'], `${label} event ${i} reason is a string`).toBe('string');
    expect(
      (event['reason'] as string).length,
      `${label} event ${i} reason non-empty`,
    ).toBeGreaterThan(0);
    expect(event['reason'], `${label} event ${i} reason`).toBe(want.reason);
    expect(event['functionName'], `${label} event ${i} functionName`).toBe(
      want.functionName === 'ANON' ? anonymous : want.functionName,
    );
    expect(event['location'], `${label} event ${i} has no location`).toBeNull();
  });
  const reasons = events.map((e) => (e as Record<string, unknown>)['reason']);
  for (const reason of ['not a Smi', 'wrong map', 'out of bounds']) {
    expect(reasons, `${label} reasons`).toContain(reason);
  }
}

function expectCounts(
  counts: Map<string, number>,
  expected: Record<string, number>,
  anonymous: string,
  label: string,
): void {
  expect(counts, `${label} counts is a Map`).toBeInstanceOf(Map);
  const want = new Map<string, number>(
    Object.entries(expected).map(([k, v]) => [k === 'ANON' ? anonymous : k, v]),
  );
  expect(counts.size, `${label} counts has one entry per function`).toBe(want.size);
  for (const [name, n] of want) {
    const got = counts.get(name);
    expect(Number.isInteger(got), `${label} count for ${name} is an integer`).toBe(true);
    expect(got, `${label} count for ${name}`).toBe(n);
  }
}

describe('deopt parser — AC-1 (plain --trace-deopt captures)', () => {
  it('AC-1: the Node 22 plain capture yields 6 eager bailout events with names, reasons, no location, and integer per-function counts', async () => {
    const { events, counts, anonymous } = await parseFixture('node22.txt');
    expectBailoutEvents(
      events,
      anonymous,
      [
        { functionName: 'add', reason: 'not a Smi' },
        { functionName: 'ANON', reason: 'Insufficient type feedback for compare operation' },
        { functionName: 'ANON', reason: 'Insufficient type feedback for call' },
        { functionName: 'getX', reason: 'wrong map' },
        { functionName: 'ANON', reason: 'Insufficient type feedback for call' },
        { functionName: 'arr', reason: 'out of bounds' },
      ],
      'node22',
    );
    expectCounts(counts, { ANON: 3, add: 1, getX: 1, arr: 1 }, anonymous, 'node22');
  });

  it('AC-1: the Node 24 plain capture yields 5 eager bailout events with names, reasons, no location, and integer per-function counts', async () => {
    const { events, counts, anonymous } = await parseFixture('node24.txt');
    expectBailoutEvents(
      events,
      anonymous,
      [
        { functionName: 'ANON', reason: 'Insufficient type feedback for call' },
        { functionName: 'add', reason: 'not a Smi' },
        { functionName: 'getX', reason: 'wrong map' },
        { functionName: 'ANON', reason: 'Insufficient type feedback for call' },
        { functionName: 'arr', reason: 'out of bounds' },
      ],
      'node24',
    );
    expectCounts(counts, { ANON: 2, add: 1, getX: 1, arr: 1 }, anonymous, 'node24');
  });
});
