---
spec_id: plugin-runner-rule-library
spec_content_hash: 2a6a43fac113477b6067e76af3f3c22eba584fdbf43ceb203ffb14945a660e35
---

## Files

- `src/plugin-runner/plugin-runner-rule-library.ac1.integration.test.ts` — the tests for AC-1
- `src/plugin-runner/plugin-runner-rule-library.ac2.integration.test.ts` — the tests for AC-2
- `src/plugin-runner/plugin-runner-rule-library.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/plugin-runner/plugin-runner-rule-library.ac1.integration.test.ts` | src/plugin-runner/index.ts#runRules(runner: PluginRunner, rules: readonly { id: string; source: string }[], windows: readonly AggregatedWindow[]): Promise<Record<string, RuleRunResult>> with eventLoopLagRule(params?: { thresholdNs?: number; windows?: number }), heapGrowthRule(params?: { windows?: number }), gcPauseShareRule(params?: { thresholdPerMille?: number }) and BuiltinRuleId { EVENT_LOOP_LAG: 'argus/event-loop-lag', HEAP_GROWTH: 'argus/heap-growth', GC_PAUSE_SHARE: 'argus/gc-pause-share' }, through createPluginRunner() — windows (start 1000 ms apart, end = start + 1000) holding a run of 3 windows with eventLoop.max > 100_000_000, a run of 3 windows with strictly rising memory.heapUsedLast, one window with gc.totalPause > 100_000_000; observed: exactly the three ids as keys, each { ok: true, findings } whose windowStart values equal exactly the covered windows' start; a second window list matching no pattern yields { ok: true, findings: [] } for all three ids; close() in afterAll
- AC-2 | integration | `src/plugin-runner/plugin-runner-rule-library.ac2.integration.test.ts` | src/plugin-runner/index.ts#eventLoopLagRule / heapGrowthRule / gcPauseShareRule, RuleParameterError and RuleErrorCode.INVALID_PARAMETER — eventLoopLagRule({ thresholdNs: -1 }), eventLoopLagRule({ windows: 0 }), heapGrowthRule({ windows: 2.5 }), gcPauseShareRule({ thresholdPerMille: '100' }) each throw synchronously a RuleParameterError with code 'ARGUS_RULE_INVALID_PARAMETER', ruleId equal to the matching BuiltinRuleId value and parameter equal to the offending name (both in the message); a spy PluginRunner whose run counts calls stays at zero calls because no descriptor is produced to pass to runRules
- AC-3 | integration | `src/plugin-runner/plugin-runner-rule-library.ac3.integration.test.ts` | src/plugin-runner/index.ts#loadRulesDirectory(dir: string): Promise<{ ok: true; rules: { id: string; source: string }[]; failures: { id: string; error: { code: string; message: string } }[] } | { ok: false; error: { code: string; message: string } }> and runRules — a temp dir with good.js (returns one finding), throws.js, broken.js (invalid JS) and notes.txt, each .js file's top level setting a globalThis marker if host-evaluated; observed: ok true with exactly 3 rules with ids broken, good, throws; runRules(createPluginRunner(), [the three built-ins, ...rules], AC-1 windows) resolves with good ok true and one finding, throws error.code RuleErrorCode.RULE_THREW, broken error.code RuleErrorCode.COMPILE_ERROR, the three built-in ids as in AC-1, and the globalThis marker unset; close() in afterAll
