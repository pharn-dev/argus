import { describe, expect, it } from 'vitest';
import { createDeoptParser } from './index.js';

function bailout(n: number): string {
  return (
    `[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing 0x1 ` +
    `<JSFunction fn${String(n)} (sfi = 0x2)>, 0x3 <Code TURBOFAN>, opt id 1, bytecode offset 0]`
  );
}

describe('deopt parser — bounded retention (F-18)', () => {
  it('keeps at most the default 1000 newest events after 10k events and counts the rest', () => {
    const parser = createDeoptParser();
    for (let i = 0; i < 10_000; i += 1) {
      parser.push(bailout(i));
    }
    const events = parser.events();
    expect(events).toHaveLength(1000);
    expect(events[0]?.functionName).toBe('fn9000');
    expect(events[999]?.functionName).toBe('fn9999');
    expect(parser.droppedEvents()).toBe(9000);
    // counts() still covers every bailout seen.
    expect([...parser.counts().values()].reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('honours a configured cap and keeps events oldest first', () => {
    const parser = createDeoptParser({ maxEvents: 3 });
    for (let i = 0; i < 10; i += 1) {
      parser.push(bailout(i));
    }
    expect(parser.events().map((e) => e.functionName)).toEqual(['fn7', 'fn8', 'fn9']);
    expect(parser.droppedEvents()).toBe(7);
  });

  it('does not parse a line longer than maxLineLength', () => {
    const parser = createDeoptParser({ maxLineLength: 200 });
    parser.push(bailout(1) + ' '.repeat(500));
    parser.push(`program output ${'x'.repeat(500)}`);
    expect(parser.events()).toHaveLength(0);
    expect(parser.unparseableLines()).toBe(1);
    parser.push(bailout(2));
    expect(parser.events()).toHaveLength(1);
  });

  it('rejects a non-positive cap', () => {
    expect(() => createDeoptParser({ maxEvents: 0 })).toThrow(RangeError);
    expect(() => createDeoptParser({ maxLineLength: -1 })).toThrow(RangeError);
  });
});
