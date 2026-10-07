import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SHA-256 of node22.txt, as pinned in pharn/features/deopt-parsing/PLAN.md Steps.
const NODE22_SHA256 = 'b7907407ed4ff66e3175644da4aa2994863689fa6f4ab3731aa6cb0d6fb2948d';

function firstNode22Headline(): string {
  const path = fileURLToPath(new URL('./__fixtures__/deopt/node22.txt', import.meta.url));
  const bytes = readFileSync(path);
  expect(createHash('sha256').update(bytes).digest('hex'), 'node22.txt SHA-256').toBe(
    NODE22_SHA256,
  );
  const line = bytes
    .toString('utf8')
    .split('\n')
    .find((l) => l.startsWith('[bailout ('));
  expect(line, 'node22.txt has a headline').toBeDefined();
  return line!;
}

describe('deopt parser — AC-3 (unparseable input is counted, never thrown)', () => {
  it('AC-3: malformed deopt-looking lines are counted (3), an empty string is not, and a following valid headline still parses', async () => {
    const { createDeoptParser } = await import('./index.js');
    const valid = firstNode22Headline();
    expect(valid, 'the valid headline names add').toContain('<JSFunction add (sfi');

    const parser = createDeoptParser();
    const inputs = [
      '[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing',
      '            ;;; deoptimize at </app/deopt.js:1:31>',
      '[marking dependent code garbage without the expected shape',
      '',
      valid,
    ];
    for (const line of inputs) {
      expect(() => parser.push(line), `push(${JSON.stringify(line)}) does not throw`).not.toThrow();
    }

    expect(parser.unparseableLines(), 'unparseable line count').toBe(3);

    const events = parser.events() as unknown[] as Record<string, unknown>[];
    expect(events, 'exactly one event').toHaveLength(1);
    expect(events[0]!['functionName']).toBe('add');
    expect(events[0]!['reason']).toBe('not a Smi');

    const count = parser.counts().get('add');
    expect(Number.isInteger(count), 'count is an integer').toBe(true);
    expect(count).toBe(1);
  });
});
