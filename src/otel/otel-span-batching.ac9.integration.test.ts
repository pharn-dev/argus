import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const otelDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(otelDir, '..');
const repoRoot = resolve(srcDir, '..');
const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const CHILD_DEADLINE_MS = 5000;

let workDir: string | undefined;

afterAll(() => {
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
});

/** Compiles src/otel (and the type-only files it reaches) to ESM in a temp dir; returns index.js. */
function compileOtel(dir: string): string {
  const outDir = join(dir, 'dist');
  mkdirSync(outDir, { recursive: true });
  const sources = readdirSync(otelDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(otelDir, f));
  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      // TS 6 refuses command-line files while a tsconfig.json is present (TS5112).
      '--ignoreConfig',
      '--outDir',
      outDir,
      '--rootDir',
      srcDir,
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      ...sources,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const entry = join(outDir, 'otel', 'index.js');
  expect(existsSync(entry), `compiling src/otel failed:\n${result.stdout}\n${result.stderr}`).toBe(
    true,
  );
  return entry;
}

/**
 * The child: creates both exporters with a long flush interval, checks they are the batching
 * exporters (item counters present and zero), and then does nothing else.
 */
function childScript(entry: string, port: number): string {
  return [
    `import { createOtlpTraceExporter, createOtlpMetricsExporter } from ${JSON.stringify(pathToFileURL(entry).href)};`,
    `const traces = createOtlpTraceExporter({ url: 'http://127.0.0.1:${port}/v1/traces', flushIntervalMs: 60000 });`,
    `const metrics = createOtlpMetricsExporter({ url: 'http://127.0.0.1:${port}/v1/metrics', flushIntervalMs: 60000 });`,
    'for (const [name, exporter] of [["traces", traces], ["metrics", metrics]]) {',
    '  for (const counter of ["droppedItems", "exportedItems", "failedItems"]) {',
    '    if (exporter[counter] !== 0) {',
    '      console.error(`${name} exporter: ${counter} is ${String(exporter[counter])}, expected 0`);',
    '      process.exitCode = 1;',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

function runChild(script: string, cwd: string): Promise<ChildResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), CHILD_DEADLINE_MS);
    child.once('error', (error) => {
      clearTimeout(killer);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(killer);
      resolveRun({ code, signal, stderr });
    });
  });
}

describe('otel span batching — AC-9', () => {
  it('AC-9: a process that only creates both exporters exits by itself with code 0 within 5000 ms', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'phargus-otel-ac9-'));
    const entry = compileOtel(workDir);

    const server: Server = createServer((request, response) => {
      request.resume();
      response.statusCode = 200;
      response.end();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    try {
      const { port } = server.address() as AddressInfo;
      const script = join(workDir, 'ac9-child.mjs');
      writeFileSync(script, childScript(entry, port));

      const startedAt = Date.now();
      const result = await runChild(script, workDir);
      const elapsed = Date.now() - startedAt;

      expect(result.signal, `the child was killed after ${CHILD_DEADLINE_MS} ms`).toBeNull();
      expect(result.code, result.stderr).toBe(0);
      expect(elapsed).toBeLessThan(CHILD_DEADLINE_MS);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      });
    }
  }, 180_000);
});
