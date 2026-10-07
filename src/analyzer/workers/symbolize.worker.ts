// Symbolization worker: the only place built files and source maps are read and parsed.
// Node core only; erasable TypeScript only (Node type stripping loads this source under vitest).
import { readFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';
import type { SerializedError, TaskReply, TaskRequest } from '../worker-protocol.js';
import type { SymbolizeResult } from '../symbolize-protocol.js';

type Frame = { url: string; line: number; column: number };

type LoadedMap =
  | { kind: 'none' }
  | { kind: 'malformed'; reason: string }
  | { kind: 'map'; map: SourceMap; sourceRoot: string; baseUrl: string };

if (parentPort === null) throw new Error('symbolize worker must run in a worker thread');
const port = parentPort;

const UNCHANGED: SymbolizeResult = { status: 'unchanged' };
const COMMENT_PREFIXES = ['//# sourceMappingURL=', '//@ sourceMappingURL='];
const BASE64_MARKER = ';base64,';

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseFrames(payload: unknown): Frame[] {
  const request = payload as { frames?: unknown } | null;
  if (typeof request !== 'object' || request === null) throw new Error('payload must be an object');
  const frames = request.frames;
  if (!Array.isArray(frames)) throw new Error('frames must be an array');
  return frames.map((item: unknown, index: number): Frame => {
    const frame = item as { url?: unknown; line?: unknown; column?: unknown } | null;
    if (
      typeof frame !== 'object' ||
      frame === null ||
      typeof frame.url !== 'string' ||
      !isPositiveInt(frame.line) ||
      !isPositiveInt(frame.column)
    ) {
      throw new Error(`frames[${index}] must have a string url and positive integer line, column`);
    }
    return { url: frame.url, line: frame.line, column: frame.column };
  });
}

/** The built file a frame points at, or undefined when the frame is not a local file. */
function builtFileOf(url: string): string | undefined {
  if (url.startsWith('file:')) return fileURLToPath(url);
  if (isAbsolute(url)) return url;
  return undefined;
}

/** The value of the last sourceMappingURL comment, found by scanning lines from the end. */
function findMappingUrl(text: string): string | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    for (const prefix of COMMENT_PREFIXES) {
      if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
    }
  }
  return undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildMap(text: string, baseUrl: string): LoadedMap {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'malformed', reason: 'source map is not a JSON object' };
    }
    const root = (parsed as { sourceRoot?: unknown }).sourceRoot;
    let sourceRoot = typeof root === 'string' ? root : '';
    if (sourceRoot !== '' && !sourceRoot.endsWith('/')) sourceRoot += '/';
    const map = new SourceMap(parsed as ConstructorParameters<typeof SourceMap>[0]);
    return { kind: 'map', map, sourceRoot, baseUrl };
  } catch (error) {
    return { kind: 'malformed', reason: reasonOf(error) };
  }
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // An unreadable file means "no map" for symbolization (SPEC assumption), not a failure.
    return undefined;
  }
}

async function loadMap(file: string): Promise<LoadedMap> {
  const builtText = await readOrUndefined(file);
  if (builtText === undefined) return { kind: 'none' };
  const value = findMappingUrl(builtText);
  if (value === undefined || value === '') return { kind: 'none' };
  const builtUrl = pathToFileURL(file).href;

  if (value.startsWith('data:')) {
    const marker = value.indexOf(BASE64_MARKER);
    if (marker < 0) return { kind: 'malformed', reason: 'inline source map is not base64' };
    const encoded = value.slice(marker + BASE64_MARKER.length);
    return buildMap(Buffer.from(encoded, 'base64').toString('utf8'), builtUrl);
  }

  let mapUrl: URL;
  try {
    mapUrl = new URL(value, builtUrl);
  } catch {
    return { kind: 'none' };
  }
  if (mapUrl.protocol !== 'file:') return { kind: 'none' };
  const mapText = await readOrUndefined(fileURLToPath(mapUrl));
  if (mapText === undefined) return { kind: 'none' };
  return buildMap(mapText, mapUrl.href);
}

function mapFrame(loaded: LoadedMap & { kind: 'map' }, frame: Frame): SymbolizeResult {
  const entry = loaded.map.findEntry(frame.line - 1, frame.column - 1);
  if (
    !('originalSource' in entry) ||
    typeof entry.originalSource !== 'string' ||
    entry.generatedLine !== frame.line - 1
  ) {
    return UNCHANGED;
  }
  const url = new URL(loaded.sourceRoot + entry.originalSource, loaded.baseUrl).href;
  return {
    status: 'mapped',
    url,
    line: entry.originalLine + 1,
    column: entry.originalColumn + (frame.column - 1 - entry.generatedColumn) + 1,
  };
}

async function handle(payload: unknown): Promise<SymbolizeResult[]> {
  const frames = parseFrames(payload);
  const results: SymbolizeResult[] = frames.map(() => UNCHANGED);
  const byFile = new Map<string, number[]>();
  frames.forEach((frame, index) => {
    const file = builtFileOf(frame.url);
    if (file === undefined) return;
    const indices = byFile.get(file);
    if (indices === undefined) byFile.set(file, [index]);
    else indices.push(index);
  });

  for (const [file, indices] of byFile) {
    const loaded = await loadMap(file);
    if (loaded.kind === 'none') continue;
    for (const index of indices) {
      const frame = frames[index];
      if (frame === undefined) continue;
      results[index] =
        loaded.kind === 'malformed'
          ? { status: 'malformed', file, reason: loaded.reason }
          : mapFrame(loaded, frame);
    }
  }
  return results;
}

function serialize(error: unknown): SerializedError {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { name: error.name, message: error.message }
      : { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}

port.on('message', (request: TaskRequest) => {
  handle(request.payload)
    .then(
      (value): TaskReply => ({ id: request.id, ok: true, value }),
      (error: unknown): TaskReply => ({ id: request.id, ok: false, error: serialize(error) }),
    )
    .then((reply) => {
      port.postMessage(reply);
    })
    .catch((error: unknown) => {
      port.postMessage({ id: request.id, ok: false, error: serialize(error) } satisfies TaskReply);
    });
});
