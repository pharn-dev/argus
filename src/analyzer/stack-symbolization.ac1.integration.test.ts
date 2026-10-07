import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type StackFrame = { url: string; line: number; column: number };
type OriginalPosition = { url: string; line: number; column: number };
type SymbolizedFrame = StackFrame & { original?: OriginalPosition; error?: Error };

type SymbolizeModule = {
  symbolizeStackFrames: (
    frames: readonly StackFrame[],
    options?: { timeoutMs?: number },
  ) => Promise<SymbolizedFrame[]>;
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
  it('AC-1: maps frames through adjacent and inline source maps and returns unmapped frames unchanged, in order', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'argus-symbolize-ac1-')));
    try {
      // Built file 1: adjacent `.map` file named by its sourceMappingURL comment.
      const adjacentFile = join(dir, 'adjacent.js');
      const adjacentMap = {
        version: 3,
        file: 'adjacent.js',
        sources: ['src/adjacent.ts'],
        names: [],
        mappings: encodeMappings([
          [[0, 0, 0, 0]],
          [
            [0, 0, 4, 2],
            [21, 0, 4, 10],
          ],
        ]),
      };
      await writeFile(
        adjacentFile,
        '"use strict";\nfunction add(a, b) { return a + b; }\n//# sourceMappingURL=adjacent.js.map\n',
      );
      await writeFile(join(dir, 'adjacent.js.map'), JSON.stringify(adjacentMap));

      // Built file 2: inline base64 `data:` URL source map.
      const inlineFile = join(dir, 'inline.js');
      const inlineMap = {
        version: 3,
        file: 'inline.js',
        sources: ['inline-src/inline.ts'],
        names: [],
        mappings: encodeMappings([[[0, 0, 2, 0]], [[0, 0, 9, 4]]]),
      };
      const inlinePayload = Buffer.from(JSON.stringify(inlineMap), 'utf8').toString('base64');
      await writeFile(
        inlineFile,
        `const x = 1;\nconsole.log(x);\n//# sourceMappingURL=data:application/json;base64,${inlinePayload}\n`,
      );

      // File 3: plain JavaScript with no source map at all.
      const plainFile = join(dir, 'plain.js');
      await writeFile(plainFile, 'const y = 2;\nconsole.log(y);\n');

      // The original sources the maps point at (their existence is not required, but keeps the fixture realistic).
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'adjacent.ts'), '// original adjacent source\n');
      await mkdir(join(dir, 'inline-src'), { recursive: true });
      await writeFile(join(dir, 'inline-src', 'inline.ts'), '// original inline source\n');

      const adjacentUrl = pathToFileURL(adjacentFile).href;
      const inlineUrl = pathToFileURL(inlineFile).href;
      const plainUrl = pathToFileURL(plainFile).href;

      const frames: StackFrame[] = [
        { url: adjacentUrl, line: 2, column: 22 },
        { url: 'node:internal/process/task_queues', line: 95, column: 5 },
        { url: inlineUrl, line: 2, column: 1 },
        { url: plainUrl, line: 1, column: 1 },
        { url: adjacentUrl, line: 1, column: 1 },
      ];
      const input = frames.map((frame) => ({ ...frame }));

      const mod = (await import('./index.js')) as unknown as SymbolizeModule;
      const result = await mod.symbolizeStackFrames(frames, { timeoutMs: 60_000 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(frames.length);

      const adjacentSourceUrl = pathToFileURL(join(dir, 'src', 'adjacent.ts')).href;
      const inlineSourceUrl = pathToFileURL(join(dir, 'inline-src', 'inline.ts')).href;

      expect(result[0]?.original).toEqual({ url: adjacentSourceUrl, line: 5, column: 11 });
      expect(result[1]).toEqual(input[1]);
      expect(result[2]?.original).toEqual({ url: inlineSourceUrl, line: 10, column: 5 });
      expect(result[3]).toEqual(input[3]);
      expect(result[4]?.original).toEqual({ url: adjacentSourceUrl, line: 1, column: 1 });

      // The caller's frames are not mutated.
      expect(frames).toEqual(input);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
