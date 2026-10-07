import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SHA-256 of each supplied capture, as pinned in pharn/features/deopt-parsing/PLAN.md Steps.
// A fixture that is altered, trimmed or re-wrapped turns these tests red.
const FIXTURE_SHA256: Record<string, string> = {
  'node22-verbose.txt': '8682f0ec744a3106e4e58901ef3bc68d2ed9174797e9c8ff13d26dd329f4fca7',
  'node24-verbose.txt': 'c8db90811a038b47cfe4ed6fcc9a2447b072c5349908f8726ec907f5622e9ebd',
  'lazy22-verbose.txt': '001f5dc088ce3f59ed9e904effbe1571a662daf336a31f2f6d011ac0e31f9b1f',
  'lazy24-verbose.txt': 'd962fd76e1057c7feccc36c32cb199321e2ba94f899cc29865bf92abba71392f',
};

function readFixture(name: string): string {
  const path = fileURLToPath(new URL(`./__fixtures__/deopt/${name}`, import.meta.url));
  const bytes = readFileSync(path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  expect(digest, `${name} matches its pinned SHA-256`).toBe(FIXTURE_SHA256[name]);
  return bytes.toString('utf8');
}

type Event = Record<string, unknown>;

type Parsed = {
  text: string;
  bailouts: Event[];
  marking: Event[];
  counts: Map<string, number>;
  dependentKind: string;
};

async function parseFixture(name: string): Promise<Parsed> {
  const { createDeoptParser, DEPENDENT_CODE_KIND } = await import('./index.js');
  const text = readFixture(name);
  const parser = createDeoptParser();
  for (const line of text.split('\n')) parser.push(line);
  const events = parser.events() as unknown[] as Event[];
  return {
    text,
    bailouts: events.filter((e) => e['kind'] !== DEPENDENT_CODE_KIND),
    marking: events.filter((e) => e['kind'] === DEPENDENT_CODE_KIND),
    counts: parser.counts(),
    dependentKind: DEPENDENT_CODE_KIND,
  };
}

function headlineCount(text: string): number {
  return text.split('\n').filter((line) => line.trimStart().startsWith('[bailout (')).length;
}

function expectBailoutsMatchHeadlines(parsed: Parsed, label: string): void {
  const headlines = headlineCount(parsed.text);
  expect(headlines, `${label} has headline lines`).toBeGreaterThan(0);
  expect(parsed.bailouts, `${label} bailout events = headline lines`).toHaveLength(headlines);
  for (const event of parsed.bailouts) {
    expect(event['kind'], `${label} bailout kind`).toBe('eager');
  }
  expect(parsed.counts.has('require'), `${label} frame-dump 'require' adds no count`).toBe(false);
  expect(
    parsed.bailouts.some((e) => e['functionName'] === 'require'),
    `${label} frame-dump 'require' adds no event`,
  ).toBe(false);
}

function expectAddLocation(parsed: Parsed, label: string): void {
  const add = parsed.bailouts.filter((e) => e['functionName'] === 'add');
  expect(add, `${label} has one add event`).toHaveLength(1);
  expect(add[0]!['location'], `${label} add location`).toEqual({
    scriptUrl: '/app/deopt.js',
    line: 1,
    column: 31,
  });
  const location = add[0]!['location'] as Record<string, unknown>;
  expect(Number.isInteger(location['line']), `${label} line is an integer`).toBe(true);
  expect(Number.isInteger(location['column']), `${label} column is an integer`).toBe(true);
}

function expectMarking(parsed: Parsed, names: string[], reason: string, label: string): void {
  expect(typeof parsed.dependentKind, 'DEPENDENT_CODE_KIND is a string').toBe('string');
  expect(parsed.dependentKind, 'DEPENDENT_CODE_KIND differs from eager').not.toBe('eager');
  const markingLines = parsed.text
    .split('\n')
    .filter((line) => line.trimStart().startsWith('[marking dependent code')).length;
  expect(parsed.marking, `${label} one event per marking line`).toHaveLength(markingLines);
  for (const name of names) {
    const match = parsed.marking.filter((e) => e['functionName'] === name);
    expect(match.length, `${label} marking event for ${name}`).toBeGreaterThan(0);
    for (const event of match) {
      expect(event['reason'], `${label} ${name} reason`).toBe(reason);
      expect(event['kind'], `${label} ${name} kind`).not.toBe('eager');
    }
  }
}

describe('deopt parser — AC-2 (--trace-deopt-verbose captures)', () => {
  it('AC-2: the Node 22 verbose capture yields one bailout per headline and locates add at /app/deopt.js:1:31', async () => {
    const parsed = await parseFixture('node22-verbose.txt');
    expectBailoutsMatchHeadlines(parsed, 'node22-verbose');
    expectAddLocation(parsed, 'node22-verbose');
  });

  it('AC-2: the Node 24 verbose capture yields one bailout per headline and locates add at /app/deopt.js:1:31', async () => {
    const parsed = await parseFixture('node24-verbose.txt');
    expectBailoutsMatchHeadlines(parsed, 'node24-verbose');
    expectAddLocation(parsed, 'node24-verbose');
  });

  it('AC-2: the Node 22 lazy capture takes the innermost position (6:18) and yields a hot dependent-code event', async () => {
    const parsed = await parseFixture('lazy22-verbose.txt');
    expectBailoutsMatchHeadlines(parsed, 'lazy22-verbose');
    const inlined = parsed.bailouts.find((e) => {
      const loc = e['location'] as Record<string, unknown> | null;
      return loc !== null && loc['line'] === 6 && loc['column'] === 18;
    });
    expect(inlined, 'lazy22 headline before the inlined position line').toBeDefined();
    expect(inlined!['location'], 'lazy22 inlined location').toEqual({
      scriptUrl: '/app/lazy.js',
      line: 6,
      column: 18,
    });
    expectMarking(parsed, ['hot'], 'code dependencies', 'lazy22-verbose');
  });

  it('AC-2: the Node 24 lazy capture yields outer and hot dependent-code events for field constness', async () => {
    const parsed = await parseFixture('lazy24-verbose.txt');
    expectBailoutsMatchHeadlines(parsed, 'lazy24-verbose');
    expectMarking(
      parsed,
      ['outer', 'hot'],
      'dependent field type constness changed',
      'lazy24-verbose',
    );
  });
});
