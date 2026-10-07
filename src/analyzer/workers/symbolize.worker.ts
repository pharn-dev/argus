// Symbolization worker: the only place built files and source maps are read and parsed.
// Node core only; erasable TypeScript only (Node type stripping loads this source under vitest).
//
// Every read is capped at `maxFileBytes`, and when the caller names `roots` every file read (built
// file and source map) must resolve, through realpath, inside one of them. Parse failures carry
// fixed reasons: V8's JSON.parse message quotes the start of the input, which must not leak.
import { open, realpath } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import type { SerializedError, TaskReply, TaskRequest } from '../worker-protocol.js';
import type { SymbolizeResult } from '../symbolize-protocol.js';

type Frame = { url: string; line: number; column: number };

type Limits = { roots: string[] | undefined; maxFileBytes: number };

type LoadedMap =
  | { kind: 'none' }
  | { kind: 'malformed'; reason: string }
  | { kind: 'map'; map: SourceMap; sourceRoot: string; baseUrl: string };

if (parentPort === null) throw new Error('symbolize worker must run in a worker thread');
const port = parentPort;

const UNCHANGED: SymbolizeResult = { status: 'unchanged' };
const COMMENT_PREFIXES = ['//# sourceMappingURL=', '//@ sourceMappingURL='];
const BASE64_MARKER = ';base64,';
const TOO_LARGE = Symbol('too large');

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

function parseLimits(payload: unknown): Limits {
  const request = payload as { roots?: unknown; maxFileBytes?: unknown };
  const { roots, maxFileBytes } = request;
  if (!isPositiveInt(maxFileBytes)) throw new Error('maxFileBytes must be a positive safe integer');
  if (roots === undefined) return { roots: undefined, maxFileBytes };
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === 'string' && root !== '')) {
    throw new Error('roots must be an array of non-empty strings');
  }
  return { roots: roots as string[], maxFileBytes };
}

/** The built file a frame points at, or undefined when the frame is not a local file. */
function builtFileOf(url: string): string | undefined {
  if (url.startsWith('file:')) {
    try {
      return fileURLToPath(url);
    } catch {
      // A file: URL with a remote host or bad encoding names no local file: frame left unchanged.
      return undefined;
    }
  }
  if (isAbsolute(url)) return url;
  return undefined;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The real paths of the roots (missing ones dropped), or undefined when reads are not confined. */
async function realRoots(roots: string[] | undefined): Promise<string[] | undefined> {
  if (roots === undefined) return undefined;
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      // A root that does not exist contains no readable file: dropping it confines reads further.
    }
  }
  return resolved;
}

/**
 * The path to read for `path`: itself when reads are not confined; its realpath when that lies
 * inside a root (so `..` and symlinks cannot escape); undefined otherwise.
 */
async function confine(path: string, roots: string[] | undefined): Promise<string | undefined> {
  if (roots === undefined) return path;
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    // Unresolvable means unreadable: "no map", as for any unreadable file.
    return undefined;
  }
  return roots.some((root) => isInside(real, root)) ? real : undefined;
}

/** Whether JSON.parse of `text` could use more than `budget` bytes of heap; allocates nothing. */
function exceedsParseBudget(text: string, budget: number): boolean {
  let estimate = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) index += 1;
      else if (code === 0x22) inString = false;
      estimate += 2;
    } else if (code === 0x22) {
      inString = true;
      estimate += 32;
    } else if (code === 0x7b) {
      estimate += 64;
    } else if (code === 0x5b) {
      estimate += 32;
    } else if (code === 0x2c || code === 0x3a) {
      estimate += 16;
    } else {
      estimate += 1;
    }
    if (estimate > budget) return true;
  }
  return false;
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

/**
 * JSON.parse is one native call: it is not interrupted when the worker nears its heap limit, and V8
 * aborts the whole process (not just this worker) if it overruns the limit. So a map whose parse
 * might not fit in half the heap still free is refused before parsing.
 */
function fitsInHeap(text: string): boolean {
  const { heap_size_limit: limit, used_heap_size: used } = getHeapStatistics();
  return !exceedsParseBudget(text, Math.max(0, (limit - used) / 2));
}

/** Reasons are fixed strings: no part of `text` (which may be any file a frame named) leaks. */
function buildMap(text: string, baseUrl: string): LoadedMap {
  if (!fitsInHeap(text)) {
    return { kind: 'malformed', reason: 'source map is too large to parse within the worker heap' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'malformed', reason: 'source map is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', reason: 'source map is not a JSON object' };
  }
  const root = (parsed as { sourceRoot?: unknown }).sourceRoot;
  let sourceRoot = typeof root === 'string' ? root : '';
  if (sourceRoot !== '' && !sourceRoot.endsWith('/')) sourceRoot += '/';
  try {
    const map = new SourceMap(parsed as ConstructorParameters<typeof SourceMap>[0]);
    return { kind: 'map', map, sourceRoot, baseUrl };
  } catch {
    return { kind: 'malformed', reason: 'source map could not be decoded' };
  }
}

/** The file's text; TOO_LARGE past `maxBytes`; undefined when it cannot be read as a file. */
async function readCapped(
  path: string,
  maxBytes: number,
): Promise<string | undefined | typeof TOO_LARGE> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    // An unreadable file means "no map" for symbolization (SPEC assumption), not a failure.
    return undefined;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    if (stats.size > maxBytes) return TOO_LARGE;
    // One byte of room past the stat() size detects a file that grew while being read.
    const buffer = Buffer.allocUnsafe(stats.size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length === buffer.length) return length > maxBytes ? TOO_LARGE : undefined;
    }
    return buffer.toString('utf8', 0, length);
  } catch {
    // As above: a read error mid-file means "no map", never a failed task.
    return undefined;
  } finally {
    await handle.close();
  }
}

async function loadMap(
  file: string,
  limits: Limits,
  roots: string[] | undefined,
): Promise<LoadedMap> {
  const readable = await confine(file, roots);
  if (readable === undefined) return { kind: 'none' };
  const builtText = await readCapped(readable, limits.maxFileBytes);
  // A built file over the cap is left unsymbolized rather than read.
  if (builtText === undefined || builtText === TOO_LARGE) return { kind: 'none' };
  const value = findMappingUrl(builtText);
  if (value === undefined || value === '') return { kind: 'none' };
  const builtUrl = pathToFileURL(file).href;

  if (value.startsWith('data:')) {
    const marker = value.indexOf(BASE64_MARKER);
    if (marker < 0) return { kind: 'malformed', reason: 'inline source map is not base64' };
    const encoded = value.slice(marker + BASE64_MARKER.length);
    return buildMap(Buffer.from(encoded, 'base64').toString('utf8'), builtUrl);
  }

  let mapPath: string;
  let mapUrl: URL;
  try {
    mapUrl = new URL(value, builtUrl);
    if (mapUrl.protocol !== 'file:') return { kind: 'none' };
    mapPath = fileURLToPath(mapUrl);
  } catch {
    return { kind: 'none' };
  }
  const mapReadable = await confine(mapPath, roots);
  if (mapReadable === undefined) return { kind: 'none' };
  const mapText = await readCapped(mapReadable, limits.maxFileBytes);
  if (mapText === undefined) return { kind: 'none' };
  if (mapText === TOO_LARGE) {
    const limit = String(limits.maxFileBytes);
    return { kind: 'malformed', reason: `source map is over the ${limit}-byte maxFileBytes limit` };
  }
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
  let url: string;
  try {
    url = new URL(loaded.sourceRoot + entry.originalSource, loaded.baseUrl).href;
  } catch {
    return UNCHANGED;
  }
  return {
    status: 'mapped',
    url,
    line: entry.originalLine + 1,
    column: entry.originalColumn + (frame.column - 1 - entry.generatedColumn) + 1,
  };
}

async function handle(payload: unknown): Promise<SymbolizeResult[]> {
  const frames = parseFrames(payload);
  const limits = parseLimits(payload);
  const roots = await realRoots(limits.roots);
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
    const loaded = await loadMap(file, limits, roots);
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
