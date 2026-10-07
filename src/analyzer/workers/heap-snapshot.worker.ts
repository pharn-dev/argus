// Heap-snapshot worker: the only place .heapsnapshot files are parsed.
// Node core only; erasable TypeScript only (Node type stripping loads this source under vitest).
//
// The file is streamed in fixed-size chunks through a small JSON tokenizer instead of being read
// into one string and passed to JSON.parse. Two reasons:
//  - memory stays bounded by the number of distinct groups, not by the file size;
//  - every allocation is small and happens in interruptible JavaScript. Node enforces a worker's
//    `resourceLimits` by asking V8 to terminate the worker near the heap limit, with only 16 MiB of
//    extra headroom. A native operation such as JSON.parse or readFile(..., 'utf8') keeps
//    allocating past that headroom before the termination can land, and V8 then aborts the whole
//    process (FATAL ERROR: Reached heap limit), taking the host down with the worker.
import { open } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import type { SerializedError, TaskReply, TaskRequest } from '../worker-protocol.js';

type TypeStats = { count: number; selfSize: number };

type Aggregate = { nodeCount: number; totalSelfSize: number; groups: Map<string, TypeStats> };

type ContainerKind = 'object' | 'array';

type TokenHandler = {
  /** How many raw bytes of the string about to start to keep (0 skips it without decoding). */
  wantString(isKey: boolean): number;
  key(text: string): void;
  string(text: string | undefined): void;
  number(value: number): void;
  literal(value: boolean | null): void;
  open(kind: ContainerKind): void;
  close(kind: ContainerKind): void;
};

if (parentPort === null) throw new Error('heap-snapshot worker must run in a worker thread');
const port = parentPort;

/** Bytes read from the file per step. The buffer lives outside the JS heap and is reused. */
const CHUNK_BYTES = 1 << 20;
/**
 * Distinct `object`/`native` node names kept per snapshot. Bounds the group map, whose largest
 * single re-allocation must stay well under the 16 MiB headroom Node grants a worker near its
 * heap limit. Real snapshots have far fewer distinct constructor names.
 */
const MAX_GROUPS = 1 << 18;
/** Raw bytes of a group name kept; a longer name is truncated and ends in an ellipsis. */
const MAX_NAME_BYTES = 1024;
const MAX_KEY_BYTES = 256;
/** Values (of any kind) accepted inside the small `snapshot` header object. */
const MAX_META_VALUES = 100_000;
const MAX_NUMBER_BYTES = 64;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

// Tokenizer states: what the next structural byte may be.
const EXPECT_VALUE = 0;
const EXPECT_VALUE_OR_CLOSE = 1;
const EXPECT_KEY_OR_CLOSE = 2;
const EXPECT_KEY = 3;
const EXPECT_COLON = 4;
const EXPECT_COMMA_OR_CLOSE = 5;
const EXPECT_END = 6;

// Token modes.
const MODE_NONE = 0;
const MODE_STRING = 1;
const MODE_NUMBER = 2;
const MODE_LITERAL = 3;

const LITERALS: Record<number, { text: string; value: boolean | null }> = {
  0x74: { text: 'true', value: true },
  0x66: { text: 'false', value: false },
  0x6e: { text: 'null', value: null },
};

class SyntaxFailure extends Error {}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function isNumberByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2b ||
    byte === 0x2e ||
    byte === 0x65 ||
    byte === 0x45
  );
}

/** Decodes the kept raw bytes of a JSON string; a truncated one is cut before a partial escape. */
function decodeString(raw: Buffer, length: number, truncated: boolean): string {
  let cut = length;
  if (truncated) {
    for (let index = 0; index < length; index += 1) {
      if (raw[index] !== 0x5c) continue;
      const escapeLength = raw[index + 1] === 0x75 ? 6 : 2;
      if (index + escapeLength > length) {
        cut = index;
        break;
      }
      index += escapeLength - 1;
    }
  }
  const text = JSON.parse(`"${raw.toString('utf8', 0, cut)}"`) as string;
  return truncated ? `${text}…` : text;
}

/** A push tokenizer: feed it chunks, it reports tokens to the handler. Strict JSON. */
function createTokenizer(handler: TokenHandler) {
  const stack: ContainerKind[] = [];
  const scratch = Buffer.allocUnsafe(Math.max(MAX_NAME_BYTES, MAX_KEY_BYTES, MAX_NUMBER_BYTES));
  let expect = EXPECT_VALUE;
  let mode = MODE_NONE;
  let offset = 0;
  // String state.
  let isKey = false;
  let escaped = false;
  let keep = 0;
  let kept = 0;
  let truncated = false;
  // Number state.
  let numberLength = 0;
  let numberValue = 0;
  let numberPlain = true;
  let numberNegative = false;
  // Literal state.
  let literal: { text: string; value: boolean | null } | undefined;
  let literalIndex = 0;

  function fail(why: string): never {
    throw new SyntaxFailure(`${why} at byte ${String(offset)}`);
  }

  function valueDone(): void {
    const top = stack[stack.length - 1];
    expect = top === undefined ? EXPECT_END : EXPECT_COMMA_OR_CLOSE;
  }

  function finishString(): void {
    mode = MODE_NONE;
    let text: string | undefined;
    if (keep > 0) {
      try {
        text = decodeString(scratch, kept, truncated);
      } catch {
        fail('invalid string');
      }
    }
    if (isKey) {
      handler.key(text ?? '');
      expect = EXPECT_COLON;
    } else {
      handler.string(text);
      valueDone();
    }
  }

  function finishNumber(): void {
    mode = MODE_NONE;
    const first = numberNegative ? 1 : 0;
    // A leading zero followed by more digits is not JSON: let the strict check reject it.
    if (scratch[first] === 0x30 && numberLength > first + 1) numberPlain = false;
    let value: number;
    if (numberPlain && numberLength <= 15 && !(numberNegative && numberLength === 1)) {
      value = numberNegative ? -numberValue : numberValue;
    } else {
      const text = scratch.toString('latin1', 0, numberLength);
      if (!JSON_NUMBER.test(text)) fail('invalid number');
      value = Number(text);
    }
    handler.number(value);
    valueDone();
  }

  function startValue(byte: number): void {
    if (byte === 0x7b) {
      stack.push('object');
      handler.open('object');
      expect = EXPECT_KEY_OR_CLOSE;
    } else if (byte === 0x5b) {
      stack.push('array');
      handler.open('array');
      expect = EXPECT_VALUE_OR_CLOSE;
    } else if (byte === 0x22) {
      startString(false);
    } else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
      mode = MODE_NUMBER;
      numberLength = 1;
      scratch[0] = byte;
      numberNegative = byte === 0x2d;
      numberValue = numberNegative ? 0 : byte - 0x30;
      numberPlain = true;
    } else if (LITERALS[byte] !== undefined) {
      mode = MODE_LITERAL;
      literal = LITERALS[byte];
      literalIndex = 1;
    } else {
      fail('unexpected character');
    }
  }

  function startString(key: boolean): void {
    mode = MODE_STRING;
    isKey = key;
    escaped = false;
    keep = handler.wantString(key);
    kept = 0;
    truncated = false;
  }

  function close(byte: number): void {
    const kind: ContainerKind = byte === 0x7d ? 'object' : 'array';
    if (stack.pop() !== kind) fail('mismatched bracket');
    handler.close(kind);
    valueDone();
  }

  function structural(byte: number): void {
    if (isWhitespace(byte)) return;
    switch (expect) {
      case EXPECT_VALUE:
        startValue(byte);
        return;
      case EXPECT_VALUE_OR_CLOSE:
        if (byte === 0x5d) close(byte);
        else startValue(byte);
        return;
      case EXPECT_KEY_OR_CLOSE:
        if (byte === 0x7d) close(byte);
        else if (byte === 0x22) startString(true);
        else fail('expected a key');
        return;
      case EXPECT_KEY:
        if (byte === 0x22) startString(true);
        else fail('expected a key');
        return;
      case EXPECT_COLON:
        if (byte === 0x3a) expect = EXPECT_VALUE;
        else fail('expected a colon');
        return;
      case EXPECT_COMMA_OR_CLOSE:
        if (byte === 0x2c) {
          expect = stack[stack.length - 1] === 'object' ? EXPECT_KEY : EXPECT_VALUE;
        } else if (byte === 0x7d || byte === 0x5d) {
          close(byte);
        } else {
          fail('expected a comma or a closing bracket');
        }
        return;
      default:
        fail('unexpected data after the end of the document');
    }
  }

  function feed(chunk: Buffer, length: number): void {
    for (let index = 0; index < length; index += 1, offset += 1) {
      const byte = chunk[index] ?? 0;
      if (mode === MODE_STRING) {
        if (escaped) {
          escaped = false;
        } else if (byte === 0x5c) {
          escaped = true;
        } else if (byte === 0x22) {
          finishString();
          continue;
        } else if (byte < 0x20) {
          fail('control character in a string');
        }
        if (keep > 0) {
          if (kept < keep) {
            scratch[kept] = byte;
            kept += 1;
          } else {
            truncated = true;
          }
        }
        continue;
      }
      if (mode === MODE_NUMBER) {
        if (isNumberByte(byte)) {
          if (numberLength >= MAX_NUMBER_BYTES) fail('number too long');
          scratch[numberLength] = byte;
          numberLength += 1;
          if (byte >= 0x30 && byte <= 0x39) numberValue = numberValue * 10 + (byte - 0x30);
          else numberPlain = false;
          continue;
        }
        finishNumber();
      } else if (mode === MODE_LITERAL && literal !== undefined) {
        if (byte !== literal.text.charCodeAt(literalIndex)) fail('invalid literal');
        literalIndex += 1;
        if (literalIndex === literal.text.length) {
          mode = MODE_NONE;
          handler.literal(literal.value);
          valueDone();
        }
        continue;
      }
      structural(byte);
    }
  }

  function end(): void {
    if (mode === MODE_NUMBER) finishNumber();
    if (mode !== MODE_NONE) fail('unexpected end of input');
    if (expect !== EXPECT_END) fail('unexpected end of input');
  }

  return { feed, end };
}

function invalid(path: string, why: string): Error {
  return new Error(`invalid heap snapshot ${path}: ${why}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

type MetaFrame = { container: unknown[] | Record<string, unknown>; key: string | undefined };

/** Streams one snapshot: builds the small header, aggregates nodes, keeps only needed names. */
function createSnapshotParser(path: string) {
  const roles: string[] = [];
  let rootKey: string | undefined;
  const seenRootKeys = new Set<string>();

  // `snapshot` header (meta), built as a plain value.
  let meta: unknown;
  let metaDone = false;
  let metaValues = 0;
  const metaStack: MetaFrame[] = [];

  // Node aggregation.
  let stride = 0;
  let typeIndex = -1;
  let nameIndex = -1;
  let sizeIndex = -1;
  let typeNames: string[] = [];
  let field = 0;
  let nodeType = 0;
  let nodeName = 0;
  let nodeSize = 0;
  let nodeCount = 0;
  let totalSelfSize = 0;
  let maxName = -1;
  let nodesDone = false;
  const nameGroups = new Map<number, TypeStats>();
  const typedGroups = new Map<string, TypeStats>();

  // Strings.
  let stringIndex = 0;
  let stringsDone = false;
  const names = new Map<number, string>();

  function top(): string | undefined {
    return roles[roles.length - 1];
  }

  function metaAdd(value: unknown): void {
    metaValues += 1;
    if (metaValues > MAX_META_VALUES) throw invalid(path, 'the snapshot header is too large');
    const frame = metaStack[metaStack.length - 1];
    if (frame === undefined) {
      meta = value;
    } else if (Array.isArray(frame.container)) {
      frame.container.push(value);
    } else if (frame.key !== undefined) {
      frame.container[frame.key] = value;
      frame.key = undefined;
    }
  }

  function wrongRootType(): void {
    if (rootKey === 'snapshot') throw invalid(path, 'meta.node_fields is not a string array');
    if (rootKey === 'nodes') throw invalid(path, 'nodes is not an array');
    if (rootKey === 'strings') throw invalid(path, 'strings is not a string array');
  }

  function beginNodes(): void {
    if (!metaDone) throw invalid(path, 'the snapshot header must come before nodes');
    const header = meta as { meta?: { node_fields?: unknown; node_types?: unknown } } | null;
    const fields = header?.meta?.node_fields;
    if (!isStringArray(fields)) throw invalid(path, 'meta.node_fields is not a string array');
    const types: unknown = Array.isArray(header?.meta?.node_types)
      ? header.meta.node_types[0]
      : undefined;
    if (!isStringArray(types)) throw invalid(path, 'meta.node_types[0] is not a string array');
    typeIndex = fields.indexOf('type');
    nameIndex = fields.indexOf('name');
    sizeIndex = fields.indexOf('self_size');
    if (typeIndex < 0 || nameIndex < 0 || sizeIndex < 0) {
      throw invalid(path, 'node_fields lacks type, name or self_size');
    }
    typeNames = types;
    stride = fields.length;
    field = 0;
  }

  function nodeField(value: number): void {
    if (!Number.isSafeInteger(value)) throw invalid(path, 'node field is not a safe integer');
    if (field === typeIndex) nodeType = value;
    if (field === nameIndex) nodeName = value;
    if (field === sizeIndex) nodeSize = value;
    field += 1;
    if (field < stride) return;
    field = 0;
    const typeName = typeNames[nodeType];
    if (typeName === undefined || nodeName < 0) {
      throw invalid(path, 'node refers to a missing type or string');
    }
    if (nodeName > maxName) maxName = nodeName;
    nodeCount += 1;
    totalSelfSize += nodeSize;
    if (typeName === 'object' || typeName === 'native') {
      const stats = nameGroups.get(nodeName);
      if (stats !== undefined) {
        stats.count += 1;
        stats.selfSize += nodeSize;
      } else if (nameGroups.size >= MAX_GROUPS) {
        throw invalid(path, `more than ${String(MAX_GROUPS)} distinct object names`);
      } else {
        nameGroups.set(nodeName, { count: 1, selfSize: nodeSize });
      }
    } else {
      const group = `(${typeName})`;
      const stats = typedGroups.get(group);
      if (stats === undefined) typedGroups.set(group, { count: 1, selfSize: nodeSize });
      else {
        stats.count += 1;
        stats.selfSize += nodeSize;
      }
    }
  }

  const handler: TokenHandler = {
    wantString(isKey) {
      const role = top();
      if (isKey) return role === 'root' || role === 'meta' ? MAX_KEY_BYTES : 0;
      if (role === 'meta') return MAX_NAME_BYTES;
      if (role === 'strings') return nameGroups.has(stringIndex) ? MAX_NAME_BYTES : 0;
      return 0;
    },
    key(text) {
      const role = top();
      if (role === 'root') {
        if (seenRootKeys.has(text) && ['snapshot', 'nodes', 'strings'].includes(text)) {
          throw invalid(path, `duplicate ${text}`);
        }
        seenRootKeys.add(text);
        rootKey = text;
      } else if (role === 'meta') {
        const frame = metaStack[metaStack.length - 1];
        if (frame !== undefined) frame.key = text;
      }
    },
    string(text) {
      const role = top();
      if (role === 'strings') {
        if (text !== undefined) names.set(stringIndex, text);
        stringIndex += 1;
      } else if (role === 'meta') metaAdd(text ?? '');
      else if (role === 'nodes') throw invalid(path, 'node field is not a safe integer');
      else if (role === 'root') wrongRootType();
    },
    number(value) {
      const role = top();
      if (role === 'nodes') nodeField(value);
      else if (role === 'strings') throw invalid(path, 'strings is not a string array');
      else if (role === 'meta') metaAdd(value);
      else if (role === 'root') wrongRootType();
    },
    literal(value) {
      const role = top();
      if (role === 'nodes') throw invalid(path, 'node field is not a safe integer');
      if (role === 'strings') throw invalid(path, 'strings is not a string array');
      if (role === 'meta') metaAdd(value);
      else if (role === 'root') wrongRootType();
    },
    open(kind) {
      const parent = top();
      if (parent === undefined) {
        if (kind !== 'object') throw invalid(path, 'the snapshot is not a JSON object');
        roles.push('root');
      } else if (parent === 'root') {
        if (rootKey === 'snapshot') {
          roles.push('meta');
          const container = kind === 'object' ? {} : [];
          metaAdd(container);
          metaStack.push({ container, key: undefined });
        } else if (rootKey === 'nodes') {
          if (kind !== 'array') throw invalid(path, 'nodes is not an array');
          beginNodes();
          roles.push('nodes');
        } else if (rootKey === 'strings') {
          if (kind !== 'array') throw invalid(path, 'strings is not a string array');
          if (!nodesDone) throw invalid(path, 'strings must come after nodes');
          roles.push('strings');
        } else {
          roles.push('skip');
        }
      } else if (parent === 'meta') {
        const container = kind === 'object' ? {} : [];
        metaAdd(container);
        metaStack.push({ container, key: undefined });
        roles.push('meta');
      } else if (parent === 'nodes') {
        throw invalid(path, 'node field is not a safe integer');
      } else if (parent === 'strings') {
        throw invalid(path, 'strings is not a string array');
      } else {
        roles.push('skip');
      }
    },
    close() {
      const role = roles.pop();
      if (role === 'meta') {
        metaStack.pop();
        if (metaStack.length === 0) metaDone = true;
      } else if (role === 'nodes') {
        if (field !== 0) throw invalid(path, 'nodes length is not a multiple of stride');
        nodesDone = true;
      } else if (role === 'strings') {
        stringsDone = true;
      }
    },
  };

  const tokenizer = createTokenizer(handler);

  function feed(chunk: Buffer, length: number): void {
    try {
      tokenizer.feed(chunk, length);
    } catch (error) {
      if (error instanceof SyntaxFailure) {
        throw new Error(`cannot parse heap snapshot ${path}: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  function finish(): Aggregate {
    try {
      tokenizer.end();
    } catch (error) {
      if (error instanceof SyntaxFailure) {
        throw new Error(`cannot parse heap snapshot ${path}: ${error.message}`, { cause: error });
      }
      throw error;
    }
    if (!metaDone) throw invalid(path, 'meta.node_fields is not a string array');
    if (!nodesDone) throw invalid(path, 'nodes is not an array');
    if (!stringsDone) throw invalid(path, 'strings is not a string array');
    if (maxName >= stringIndex) throw invalid(path, 'node refers to a missing type or string');
    const groups = new Map<string, TypeStats>(typedGroups);
    for (const [index, stats] of nameGroups) {
      const name = names.get(index) ?? '';
      const existing = groups.get(name);
      if (existing === undefined) groups.set(name, stats);
      else {
        existing.count += stats.count;
        existing.selfSize += stats.selfSize;
      }
    }
    return { nodeCount, totalSelfSize, groups };
  }

  return { feed, finish };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function load(
  path: unknown,
  field: string,
  maxBytes: number | undefined,
): Promise<Aggregate> {
  if (typeof path !== 'string' || path === '')
    throw new Error(`${field} must be a non-empty string`);
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    throw new Error(`cannot read heap snapshot ${path}: ${messageOf(error)}`, { cause: error });
  }
  try {
    const parser = createSnapshotParser(path);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null));
      } catch (error) {
        throw new Error(`cannot read heap snapshot ${path}: ${messageOf(error)}`, {
          cause: error,
        });
      }
      if (bytesRead === 0) break;
      total += bytesRead;
      if (maxBytes !== undefined && total > maxBytes) {
        throw new Error(
          `heap snapshot ${path} is larger than the ${String(maxBytes)}-byte limit (maxSnapshotBytes)`,
        );
      }
      parser.feed(buffer, bytesRead);
    }
    return parser.finish();
  } finally {
    await file.close();
  }
}

function byNameAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function handle(payload: unknown): Promise<unknown> {
  const request = payload as {
    kind?: unknown;
    path?: unknown;
    beforePath?: unknown;
    afterPath?: unknown;
    top?: unknown;
    maxBytes?: unknown;
  } | null;
  if (typeof request !== 'object' || request === null) throw new Error('payload must be an object');
  const top = request.top;
  if (typeof top !== 'number' || !Number.isSafeInteger(top) || top <= 0) {
    throw new Error('top must be a positive safe integer');
  }
  const maxBytes = request.maxBytes;
  if (
    maxBytes !== undefined &&
    (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
  ) {
    throw new Error('maxBytes must be a positive safe integer');
  }
  if (request.kind === 'summary') {
    const result = await load(request.path, 'path', maxBytes);
    const entries = [...result.groups].map(([name, stats]) => ({ name, ...stats }));
    entries.sort((a, b) => b.selfSize - a.selfSize || byNameAscending(a.name, b.name));
    return {
      nodeCount: result.nodeCount,
      totalSelfSize: result.totalSelfSize,
      top: entries.slice(0, top),
    };
  }
  if (request.kind === 'diff') {
    const before = await load(request.beforePath, 'beforePath', maxBytes);
    const beforeTotals = { nodeCount: before.nodeCount, totalSelfSize: before.totalSelfSize };
    const beforeGroups = before.groups;
    const after = await load(request.afterPath, 'afterPath', maxBytes);
    const names = new Set([...beforeGroups.keys(), ...after.groups.keys()]);
    const entries = [...names].map((name) => {
      const was = beforeGroups.get(name);
      const now = after.groups.get(name);
      return {
        name,
        countDelta: (now?.count ?? 0) - (was?.count ?? 0),
        selfSizeDelta: (now?.selfSize ?? 0) - (was?.selfSize ?? 0),
      };
    });
    entries.sort((a, b) => b.selfSizeDelta - a.selfSizeDelta || byNameAscending(a.name, b.name));
    return {
      entries: entries.slice(0, top),
      before: beforeTotals,
      after: { nodeCount: after.nodeCount, totalSelfSize: after.totalSelfSize },
    };
  }
  throw new Error('unknown task kind');
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
