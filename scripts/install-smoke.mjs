// Copied into the temporary consumer by check-install.mjs. All product imports resolve there.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const [format, phase] = process.argv.slice(2);
assert.ok(format === 'import' || format === 'require');
assert.ok(phase === 'core' || phase === 'plugins');
const pkg = JSON.parse(await readFile('node_modules/@pharn-dev/phargus/package.json', 'utf8'));
const load = (subpath) => {
  const name = `${pkg.name}/${subpath}`;
  return format === 'import' ? import(name) : Promise.resolve(require(name));
};

async function checkPlugins(installed) {
  const { createPluginRunner, RuleErrorCode } = await load('plugin-runner');
  const runner = createPluginRunner({ timeoutMs: 2000 });
  try {
    const result = await runner.run('return [{ windowStart: 0, message: "packed sandbox" }];', []);
    if (installed) {
      assert.deepEqual(result, {
        ok: true,
        findings: [{ windowStart: 0, message: 'packed sandbox' }],
      });
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, RuleErrorCode.ISOLATED_VM_MISSING);
    }
  } finally {
    await runner.close();
  }
}

async function checkAnalyzer() {
  const { summarizeHeapSnapshot, symbolizeStackFrames } = await load('analyzer');
  const snapshot = join(process.cwd(), `${format}.heapsnapshot`);
  await writeFile(
    snapshot,
    JSON.stringify({
      snapshot: { meta: { node_fields: ['type', 'name', 'self_size'], node_types: [['object']] } },
      nodes: [0, 0, 10, 0, 1, 20],
      strings: ['Alpha', 'Beta'],
    }),
  );
  const summary = await summarizeHeapSnapshot(snapshot, { timeoutMs: 5000 });
  assert.equal(summary.nodeCount, 2);
  assert.equal(summary.totalSelfSize, 30);
  assert.equal(summary.top[0].name, 'Beta');

  const built = join(process.cwd(), `${format}-mapped.js`);
  await writeFile(built, 'const value = 1;\n//# sourceMappingURL=mapped.js.map\n');
  await writeFile(
    join(process.cwd(), 'mapped.js.map'),
    JSON.stringify({
      version: 3,
      sources: ['original.ts'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: ['const value: number = 1;'],
    }),
  );
  const frames = await symbolizeStackFrames(
    [{ url: pathToFileURL(built).href, line: 1, column: 1 }],
    { roots: [process.cwd()], timeoutMs: 5000 },
  );
  assert.ok(frames[0].original?.url.endsWith('/original.ts'));
  assert.equal(frames[0].original.line, 1);
}

async function checkDashboard() {
  const agent = await load('agent');
  const { createCollector } = await load('collector');
  const { createDashboardServer } = await load('dashboard');
  const collector = createCollector({ windowMs: 100, capacity: 10 });
  const transport = new PassThrough();
  const exporter = agent.createNdjsonExporter(transport);
  // Observe pipeline failures immediately, even before the sampler finishes.
  const exporting = exporter.done.then(
    () => undefined,
    (error) => error,
  );
  const controller = agent.createSamplerController((sample) => exporter.export(sample), {
    onError(error) {
      errors.push(error);
    },
  });
  let dashboard;
  let reader;
  let consumed;
  const errors = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('dashboard smoke timed out')), 10000);
  async function* decode() {
    let pending = '';
    for await (const chunk of transport) {
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        yield JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    assert.equal(pending, '');
  }
  try {
    dashboard = await createDashboardServer({
      collector,
      host: '127.0.0.1',
      port: 0,
      onError: (error) => errors.push(error),
    });
    for (const path of ['/', '/app.js', '/app.css']) {
      const response = await fetch(`${dashboard.url}${path}`, { signal: abort.signal });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).length > 0);
    }
    const response = await fetch(`${dashboard.url}/events`, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    reader = response.body.getReader();
    consumed = collector.consume(decode()).then(
      () => undefined,
      (error) => error,
    );
    controller.start(25);
    let events = '';
    while (!/event: window\ndata: .*\n\n/.test(events)) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      events += Buffer.from(value).toString();
    }
    const data = /event: window\ndata: (.*)\n\n/.exec(events);
    assert.ok(data, 'SSE must contain a complete window');
    const window = JSON.parse(data[1]);
    assert.ok(window.count > 0);
    assert.ok(window.memory.heapUsedLast > 0);
    assert.ok(collector.windows.size() > 0);
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
    controller.stop();
    const cancelled = await Promise.allSettled([reader?.cancel()]);
    abort.abort();
    // Collect every cleanup outcome; no failure may prevent the remaining cleanup.
    const results = await Promise.allSettled([
      exporter.stop(),
      consumed,
      dashboard?.close(),
      collector.close(),
    ]);
    const exportError = await exporting;
    if (exportError !== undefined) errors.push(exportError);
    for (const result of [...cancelled, ...results]) {
      if (result.status === 'rejected') errors.push(result.reason);
      else if (result.value instanceof Error) errors.push(result.value);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'dashboard smoke or cleanup failed');
}

if (phase === 'core') {
  for (const subpath of Object.keys(pkg.exports)) {
    if (subpath !== './package.json') await load(subpath.slice(2));
  }
  assert.throws(() => require.resolve('isolated-vm'), { code: 'MODULE_NOT_FOUND' });
  await checkPlugins(false);
  await checkAnalyzer();
  await checkDashboard();
} else {
  await checkPlugins(true);
}
console.log(`ok   ${format} installed ${phase} (${pkg.name}@${pkg.version})`);
