import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** A virtual agent source file (never written to disk) that imports from the CLI's directory. */
const PROBE_PATH = join(repoRoot, 'src', 'agent', '__phargus-serve-cli-ac10-probe__.ts');
const PROBE_SOURCE = [
  "import { runServe } from '../cli/serve.js';",
  '',
  'export const probe: unknown = runServe;',
  '',
].join('\n');

describe("ESLint boundary: the agent may not import the CLI's source", () => {
  it("AC-10: linting a src/agent/ file that imports '../cli/serve.js' with the repo's ESLint config reports a no-restricted-imports error for that import", async () => {
    const { ESLint } = await import('eslint');
    // Only the boundary rule runs, and without type information: the probe is not on disk, so the
    // typed project service could not load it. The repo's own config still decides the rule's
    // options for files under src/agent/.
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfig: {
        languageOptions: { parserOptions: { projectService: false, project: false } },
      },
      ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports',
    });

    const results = await eslint.lintText(PROBE_SOURCE, { filePath: PROBE_PATH });
    expect(results).toHaveLength(1);
    const messages = results[0]?.messages ?? [];
    const summary = JSON.stringify(messages, null, 2);

    expect(
      messages.filter((message) => message.fatal === true),
      summary,
    ).toEqual([]);
    const boundary = messages.filter(
      (message) => message.ruleId === 'no-restricted-imports' && message.severity === 2,
    );
    expect(boundary, summary).toHaveLength(1);
    expect(boundary[0]?.line, summary).toBe(1);
  }, 120_000);
});
