---
spec_id: collector-alerts
spec_content_hash: f34f0ce5224b604af5b5de95b9ed78ab1e72d6bb9ae3bc51070f9478c03e91c2
---

## Files

- `src/collector/collector-alerts.ac1.test.ts` — the tests for AC-1
- `src/collector/collector-alerts.ac2.test.ts` — the tests for AC-2
- `src/collector/collector-alerts.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/collector/collector-alerts.ac1.test.ts` | src/collector/index.ts#createAlertEvaluator(rules: readonly AlertRule[]): Transform — AlertRule = { id: string; metric: AlertMetric; comparison: '>' | '>='; threshold: number; forWindows?: number }; object-mode node:stream Transform; write AggregatedWindow objects (src/collector/index.ts type), end(), read Alert = { ruleId; metric; comparison; threshold; observed; windowStart; windowEnd; state: 'firing' | 'resolved' }
- AC-2 | unit | `src/collector/collector-alerts.ac2.test.ts` | src/collector/index.ts#createAlertEvaluator(rules: readonly AlertRule[]): Transform and src/collector/index.ts#createCollector(options: { windowMs: number; capacity: number; alerts?: readonly AlertRule[] }): Collector — each invalid rule set makes both throw synchronously with a message containing the offending rule id
- AC-3 | unit | `src/collector/collector-alerts.ac3.test.ts` | src/collector/index.ts#createCollector(options: { windowMs: number; capacity: number; alerts?: readonly AlertRule[] }): Collector — consume(source: Readable | AsyncIterable<AgentSample>): Promise<void>; windows.snapshot(): AggregatedWindow[]; alerts.snapshot(): Alert[] (oldest first); a Readable.from source for the resolve case and a Readable that destroy(err)s for the reject case
