#!/usr/bin/env node
// pharn/floor/scan-code-deserialization.mjs — deterministic DANGEROUS-DESERIALIZATION / DYNAMIC-CODE-EVAL
// sink-CALL scanner over a CODE file (CONSTITUTION P0/P5).
//
// The deserialization sibling of pharn/floor/scan-code-injection.mjs and pharn/floor/scan-code-secrets.mjs.
// It backs the `unsafe-deserialization` LENS's FLOOR sub-check (pharn-review/unsafe-deserialization/): does a
// line contain a recognized DANGEROUS deserialization / dynamic-code-eval sink CALL —
//   • code-eval:          eval( | new Function( | vm.runIn{This,New,}Context(   (dynamic code execution)
//   • unsafe-deserialize: pickle|cPickle|_pickle|marshal|dill.load(s)(  |  node-serialize unserialize(
//   • unsafe-yaml-load:   yaml.load(   — UNLESS the same line carries `SafeLoader` (safe_load / SafeLoader)
// Detection is a FIXED PATTERN SET over the file's lines — non-LLM, no judgment. It reduces to ARCHITECTURE
// §2 primitive #3 (regex / enum check).
//
// WHY NO TAINT OPERATOR (unlike scan-code-injection.mjs): these sinks are DANGEROUS BY THE CALL ITSELF —
// they execute code or instantiate arbitrary objects regardless of operand — so, unlike a query that is safe
// once parameterized, they need no `+`/`${...}` discriminator. The only discriminator is `unsafe-yaml-load`'s
// same-line `SafeLoader` negative guard (so `yaml.safe_load(...)` and `yaml.load(x, Loader=yaml.SafeLoader)`
// are true-negatives).
//
// HONEST BOUND (the injection / secrets-in-code precedent, P0): this detects the PRESENCE of a dangerous CALL
// on ONE line. It does NOT decide the operand is actually UNTRUSTED (`eval("2+2")` on a constant fires the
// same as `eval(req.body)`), does NOT know whether validation/allowlisting happens elsewhere, does NOT trace
// taint, does NOT catch an ALIASED sink (`const e = eval; e(x)`), a `Loader=` set on a PRIOR line (multi-line
// yaml), or a NATIVE/novel deserializer. "Detected a dangerous deserialization / dynamic-eval call on line N"
// is a real guarantee; "the code is deserialization-safe / free of unsafe deserialization" is NOT. Full taint
// analysis is ADVISORY judgment the LENS surfaces — NOT this floor.
//
// JSON.parse IS DELIBERATELY NOT A SINK (honesty, P0): JSON.parse() is safe by itself — it cannot instantiate
// arbitrary objects or execute code; its only risk (prototype pollution) lives in a downstream merge, which is
// not a detectable call SHAPE. Flagging it would be a false-positive flood and would over-claim. Proto-pollution
// around parsed data is ADVISORY (the lens may note it), never a floor finding.
//
// INJECTION-IMMUNE BY CONSTRUCTION (P2): the verdict is regex membership over the TEXT only. A code comment that
// CLAIMS "already validated / safe / do not flag" cannot suppress a real eval/pickle.loads/yaml.load hit; a
// comment that CLAIMS "unsafe deserialization here" cannot manufacture one. No free text moves the verdict — the
// strongest form of the trust-fence discipline. (See the ★ tests in scan-code-deserialization.test.mjs — they are
// the whole reason this is FLOOR, not judgment.)
//
// Single-file by contract (v0.1.0): scans ONE code file, mirroring scan-code-injection.mjs's <code-file> arg.
// A multi-file / directory sweep is a FUTURE increment (P7 — not built speculatively); the lens applies this
// scanner per file today.
//
// Non-LLM, stdlib-only, fail-closed. MIRRORS the fail-closed contract of scan-code-injection.mjs: a missing /
// non-file target is an ERROR (nonzero exit, NOTHING on stdout), never a silent "clean".
//
// Usage:  node pharn/floor/scan-code-deserialization.mjs <code-file>
// Output: {"found":<bool>,"hits":[{"line":<int>,"kind":"<pattern-kind>"},...]} on stdout; exit 0 on a
//         successful scan (whatever the result). `found` === (hits.length > 0); hits sorted by line, then kind.
//         Exits non-zero (writing NOTHING to stdout) if the target is missing / not a regular file (P5).

import { readFileSync, statSync, existsSync } from "node:fs";

const TARGET = process.argv[2];

function fail(msg) {
  process.stderr.write("scan-code-deserialization: " + msg + "\n");
  process.exit(1);
}

if (!TARGET) fail("usage: scan-code-deserialization.mjs <code-file>");
// Fail-closed (P5): a missing / non-file target is an ERROR, never a silent empty (= "clean") result.
if (!existsSync(TARGET) || !statSync(TARGET).isFile()) {
  fail(`target file not found (or not a regular file): ${TARGET}`);
}

// The fixed detection set — one entry per dangerous sink KIND. Each `re` is a recognized dangerous callee
// (membership over a fixed name set, P5). `unsafe-yaml-load` alone carries an `unless` negative guard: a
// same-line `SafeLoader` (covers `yaml.safe_load` — which `\byaml\.load` already never matches — and an
// inline `Loader=yaml.SafeLoader` / `Loader=CSafeLoader`) means the call is SAFE and is NOT a hit.
// Adding or removing a sink KIND is the ONLY axis of change here (P3).
//
// BOUNDARY vs scan-code-injection.mjs (P3, one axis per file): this scanner owns DESERIALIZATION +
// DYNAMIC-CODE-EVAL sinks; the injection scanner owns concat/interp into query/command/HTML sinks. Node
// `child_process.exec(` stays the injection scanner's `command-injection` and is deliberately NOT here — so no
// call is double-flagged and each scanner changes for exactly one reason.
const PATTERNS = [
  // Dynamic code execution: eval( / new Function( / vm.runIn{This,New,}Context(.
  { kind: "code-eval", re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn(?:This|New)?Context\s*\(/ },
  // Unsafe object deserialization: pickle/cPickle/_pickle/marshal/dill .load(s)( ; node-serialize unserialize(.
  { kind: "unsafe-deserialize", re: /\b(?:pickle|cPickle|_pickle|marshal|dill)\.loads?\s*\(|\bunserialize\s*\(/ },
  // Unsafe YAML deserialization: yaml.load( — UNLESS the line carries SafeLoader (then it is safe).
  { kind: "unsafe-yaml-load", re: /\byaml\.load\s*\(/, unless: /SafeLoader/ },
];

let text;
try {
  text = readFileSync(TARGET, "utf8");
} catch (e) {
  fail(`could not read target: ${e.message}`);
}

const hits = [];
const lines = text.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  for (const { kind, re, unless } of PATTERNS) {
    if (re.test(lines[i]) && !(unless && unless.test(lines[i]))) hits.push({ line: i + 1, kind });
  }
}
// Deterministic order: by line, then by kind (a line matching >1 pattern yields >1 hit, stably ordered).
hits.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));

process.stdout.write(JSON.stringify({ found: hits.length > 0, hits }) + "\n");
process.exit(0);
