// Heap-snapshot worker: the only place .heapsnapshot files are parsed.
// Node core only; erasable TypeScript only (Node type stripping loads this source under vitest).
import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import type { SerializedError, TaskReply, TaskRequest } from '../worker-protocol.js';

type TypeStats = { count: number; selfSize: number };

type Aggregate = { nodeCount: number; totalSelfSize: number; groups: Map<string, TypeStats> };

if (parentPort === null) throw new Error('heap-snapshot worker must run in a worker thread');
const port = parentPort;

function invalid(path: string, why: string): Error {
  return new Error(`invalid heap snapshot ${path}: ${why}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function aggregate(snapshot: unknown, path: string): Aggregate {
  const root = snapshot as {
    snapshot?: { meta?: { node_fields?: unknown; node_types?: unknown } };
    nodes?: unknown;
    strings?: unknown;
  } | null;
  const meta = root?.snapshot?.meta;
  const fields = meta?.node_fields;
  if (!isStringArray(fields)) throw invalid(path, 'meta.node_fields is not a string array');
  const typeNames: unknown = Array.isArray(meta?.node_types) ? meta.node_types[0] : undefined;
  if (!isStringArray(typeNames)) throw invalid(path, 'meta.node_types[0] is not a string array');
  const nodes = root?.nodes;
  const strings = root?.strings;
  if (!Array.isArray(nodes)) throw invalid(path, 'nodes is not an array');
  if (!isStringArray(strings)) throw invalid(path, 'strings is not a string array');
  const typeIndex = fields.indexOf('type');
  const nameIndex = fields.indexOf('name');
  const sizeIndex = fields.indexOf('self_size');
  if (typeIndex < 0 || nameIndex < 0 || sizeIndex < 0) {
    throw invalid(path, 'node_fields lacks type, name or self_size');
  }
  const stride = fields.length;
  if (nodes.length % stride !== 0) throw invalid(path, 'nodes length is not a multiple of stride');

  const groups = new Map<string, TypeStats>();
  let totalSelfSize = 0;
  const nodeCount = nodes.length / stride;
  for (let offset = 0; offset < nodes.length; offset += stride) {
    const type: unknown = nodes[offset + typeIndex];
    const name: unknown = nodes[offset + nameIndex];
    const selfSize: unknown = nodes[offset + sizeIndex];
    if (
      typeof type !== 'number' ||
      typeof name !== 'number' ||
      typeof selfSize !== 'number' ||
      !Number.isSafeInteger(type) ||
      !Number.isSafeInteger(name) ||
      !Number.isSafeInteger(selfSize)
    ) {
      throw invalid(path, 'node field is not a safe integer');
    }
    const typeName = typeNames[type];
    const text = strings[name];
    if (typeName === undefined || text === undefined) {
      throw invalid(path, 'node refers to a missing type or string');
    }
    const group = typeName === 'object' || typeName === 'native' ? text : `(${typeName})`;
    const stats = groups.get(group);
    if (stats === undefined) groups.set(group, { count: 1, selfSize });
    else {
      stats.count += 1;
      stats.selfSize += selfSize;
    }
    totalSelfSize += selfSize;
  }
  return { nodeCount, totalSelfSize, groups };
}

async function load(path: unknown, field: string): Promise<Aggregate> {
  if (typeof path !== 'string' || path === '')
    throw new Error(`${field} must be a non-empty string`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read heap snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse heap snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return aggregate(parsed, path);
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
  } | null;
  if (typeof request !== 'object' || request === null) throw new Error('payload must be an object');
  const top = request.top;
  if (typeof top !== 'number' || !Number.isSafeInteger(top) || top <= 0) {
    throw new Error('top must be a positive safe integer');
  }
  if (request.kind === 'summary') {
    const result = await load(request.path, 'path');
    const entries = [...result.groups].map(([name, stats]) => ({ name, ...stats }));
    entries.sort((a, b) => b.selfSize - a.selfSize || byNameAscending(a.name, b.name));
    return {
      nodeCount: result.nodeCount,
      totalSelfSize: result.totalSelfSize,
      top: entries.slice(0, top),
    };
  }
  if (request.kind === 'diff') {
    const before = await load(request.beforePath, 'beforePath');
    const beforeTotals = { nodeCount: before.nodeCount, totalSelfSize: before.totalSelfSize };
    const beforeGroups = before.groups;
    const after = await load(request.afterPath, 'afterPath');
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
