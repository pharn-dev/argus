---
spec_id: deopt-parsing
spec_content_hash: 5d64f0d2e6004d0dd168f8a42c0369b49dfee8f8851b21033b93ac3b47c6c822
---

## Files

- `src/agent/deopt-parsing.ac1.test.ts` — the tests for AC-1
- `src/agent/deopt-parsing.ac2.test.ts` — the tests for AC-2
- `src/agent/deopt-parsing.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/deopt-parsing.ac1.test.ts` | src/agent/index.ts#createDeoptParser(): DeoptParser — DeoptParser = { push(line: string): void; events(): DeoptEvent[]; counts(): Map<string, number>; unparseableLines(): number }; DeoptEvent = { kind: string; reason: string; functionName: string; tier: string; location: { scriptUrl: string; line: number; column: number } | null }; plus src/agent/index.ts#ANONYMOUS_FUNCTION: string; driven in-process (vitest, imported from ./index.js) with every line of src/agent/__fixtures__/deopt/node22.txt and node24.txt (read with node:fs, SHA-256 checked against PLAN.md Steps first), one fresh parser per fixture
- AC-2 | unit | `src/agent/deopt-parsing.ac2.test.ts` | src/agent/index.ts#createDeoptParser(): DeoptParser (shape as AC-1) plus src/agent/index.ts#ANONYMOUS_FUNCTION and #DEPENDENT_CODE_KIND: string; driven in-process (vitest, imported from ./index.js) with every line of src/agent/__fixtures__/deopt/node22-verbose.txt, node24-verbose.txt, lazy22-verbose.txt and lazy24-verbose.txt (SHA-256 checked first), one fresh parser per fixture; bailout events filtered by kind !== DEPENDENT_CODE_KIND
- AC-3 | unit | `src/agent/deopt-parsing.ac3.test.ts` | src/agent/index.ts#createDeoptParser(): DeoptParser (shape as AC-1); driven in-process (vitest, imported from ./index.js) with push() of a truncated `[bailout (` headline, an orphan `;;; deoptimize at` line, a malformed `[marking dependent code` line, an empty string, then one valid headline line taken from src/agent/__fixtures__/deopt/node22.txt; asserts no throw, unparseableLines() === 3, one event, counts() entry === 1
