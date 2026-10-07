import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type StackFrame = { url: string; line: number; column: number };
type OriginalPosition = { url: string; line: number; column: number };
type SymbolizedFrame = StackFrame & {
  original?: OriginalPosition;
  error?: Error & { code?: unknown };
};

type SymbolizeModule = {
  symbolizeStackFrames: (
    frames: readonly StackFrame[],
    options?: { timeoutMs?: number },
  ) => Promise<SymbolizedFrame[]>;
  MalformedSourceMapError: abstract new (...args: never[]) => Error;
};

// One source-map segment: [generatedColumn, sourceIndex, originalLine, originalColumn], all 0-based.
type Segment = [number, number, number, number];

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 32;
    }
    out += BASE64.charAt(digit);
  } while (vlq > 0);
  return out;
}

// Encodes per-generated-line segment lists into a v3 `mappings` string.
function encodeMappings(lines: Segment[][]): string {
  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  return lines
    .map((segments) => {
      let previousGeneratedColumn = 0;
      return segments
        .map(([generatedColumn, source, originalLine, originalColumn]) => {
          const encoded =
            encodeVlq(generatedColumn - previousGeneratedColumn) +
            encodeVlq(source - previousSource) +
            encodeVlq(originalLine - previousOriginalLine) +
            encodeVlq(originalColumn - previousOriginalColumn);
          previousGeneratedColumn = generatedColumn;
          previousSource = source;
          previousOriginalLine = originalLine;
          previousOriginalColumn = originalColumn;
          return encoded;
        })
        .join(',');
    })
    .join(';');
}

describe('analyzer stack symbolization', () => {
  it('AC-2: attaches a typed error to frames of a malformed source map and still maps the other frames', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'argus-symbolize-ac2-')));
    try {
      // Built file whose adjacent `.map` file is not valid JSON.
      const badFile = join(dir, 'bad.js');
      await writeFile(
        badFile,
        'const broken = 1;\nconsole.log(broken);\n//# sourceMappingURL=bad.js.map\n',
      );
      await writeFile(join(dir, 'bad.js.map'), '{ "version": 3, "sources": [ this is not json');

      // Built file with a valid adjacent `.map` file.
      const goodFile = join(dir, 'good.js');
      const goodMap = {
        version: 3,
        file: 'good.js',
        sources: ['src/good.ts'],
        names: [],
        mappings: encodeMappings([[[0, 0, 6, 2]], [[0, 0, 7, 4]]]),
      };
      await writeFile(
        goodFile,
        'const fine = 1;\nconsole.log(fine);\n//# sourceMappingURL=good.js.map\n',
      );
      await writeFile(join(dir, 'good.js.map'), JSON.stringify(goodMap));
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'good.ts'), '// original good source\n');

      const badFrame: StackFrame = { url: pathToFileURL(badFile).href, line: 2, column: 1 };
      const goodFrame: StackFrame = { url: pathToFileURL(goodFile).href, line: 2, column: 1 };

      const mod = (await import('./index.js')) as unknown as SymbolizeModule;
      const result = await mod.symbolizeStackFrames([badFrame, goodFrame], { timeoutMs: 60_000 });

      expect(result).toHaveLength(2);

      const good = result[1];
      expect(good?.original).toEqual({
        url: pathToFileURL(join(dir, 'src', 'good.ts')).href,
        line: 8,
        column: 5,
      });
      expect(good?.error).toBeUndefined();

      const bad = result[0];
      expect(bad?.url).toBe(badFrame.url);
      expect(bad?.line).toBe(badFrame.line);
      expect(bad?.column).toBe(badFrame.column);
      expect(bad?.error).toBeInstanceOf(mod.MalformedSourceMapError);
      expect(bad?.error).toBeInstanceOf(Error);
      expect(bad?.error?.name).toBe('MalformedSourceMapError');
      expect(bad?.error?.code).toBe('ERR_MALFORMED_SOURCE_MAP');
      expect(bad?.error?.message).toContain(badFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
