---
spec_id: agent-config
spec_content_hash: b62ddaedd1c83680c9c5120e7e8bd791a84cda3c03683263df20f589383bbdbb
---

## Files

- `src/agent/config.ac1.integration.test.ts` — the tests for AC-1
- `src/agent/config.ac2.integration.test.ts` — the tests for AC-2
- `src/agent/config.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/agent/config.ac1.integration.test.ts` | src/agent/index.ts#loadAgentConfig(cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<AgentConfig> and defaultAgentConfig.queueBound — a temp dir with argus.config.json { intervalMs, output: <absolute path> } and env { ARGUS_INTERVAL_MS, ARGUS_ENABLED: "0" }; AgentConfig = Readonly<{ intervalMs: number; output: string; queueBound: number; enabled: boolean }>
- AC-2 | integration | `src/agent/config.ac2.integration.test.ts` | src/agent/index.ts#loadAgentConfig(cwd, {}): Promise<AgentConfig> — one temp dir with package.json {"type":"commonjs"} and argus.config.js assigning module.exports, one with package.json {"type":"module"} and argus.config.js with export default; each sets intervalMs, queueBound and an absolute output
- AC-3 | integration | `src/agent/config.ac3.integration.test.ts` | src/agent/index.ts#loadAgentConfig(cwd, env): Promise<AgentConfig> rejects — six setups (invalid JSON, unknown key foo, queueBound 0, ARGUS_INTERVAL_MS "abc", ARGUS_ENABLED "yes", both config files); each rejection's message contains the source name (argus.config.json / ARGUS_INTERVAL_MS / ARGUS_ENABLED) and the key where one applies, and the both-files message contains argus.config.json and argus.config.js
