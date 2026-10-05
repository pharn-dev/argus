#!/usr/bin/env node
// pharn/floor/scan-installed-skills.mjs — deterministic enumerator of USER-installed Claude Code skills.
//
// Answers ONE structural question for the product stages /pharn-build, /pharn-grill, /pharn-review:
// which skills has the user installed into THIS repo? A Claude Code project skill lives at
// `<repo>/.claude/skills/<name>/SKILL.md` (one directory level; the SKILL.md is its entrypoint). This
// helper lists exactly those — by DIRECTORY PRESENCE, never by reading the SKILL.md's content — and
// prints a sorted JSON roster.
//
// WHAT THIS IS (and is NOT), per P0. This is a deterministic ENUMERATION (a filesystem listing) — it is
// FLOOR-grade in the narrow sense that its output is reproducible and non-LLM. But it GATES NOTHING: no
// proceed/stop/verdict in any stage reads this output. INCORPORATING the listed skills (letting their
// SKILL.md content shape the built code, or the grill/review concerns) is ADVISORY model work, done by
// the stage, NOT here. So this helper is the enumerator half of the count-grillers pattern (membership is
// deterministic; RUNNING/USING the members is advisory) — with the crucial difference that a griller
// roster GATES which grillers run, whereas this roster gates nothing. There is deliberately NO claim here
// that built code "matches" or "conforms to" a skill; that check does not exist and is not added (that
// would be the P0 disease — "in the contract" mistaken for "guaranteed").
//
// TRUST (P2). A `.claude/skills/*/SKILL.md` is user-dropped markdown — `trust: untrusted`, NOT one of the
// four write-protected trusted docs (LIMITS.md §1a "markdown is executable" applies). This helper is
// safe to run on hostile input because it reads ONLY directory/entry NAMES, never SKILL.md bodies: the
// stage that later reads the bodies treats them as untrusted DATA. Enumeration hygiene (from the grill):
//   - EXACTLY one level — entries directly under `.claude/skills/`, each a real dir holding a real
//     `SKILL.md` FILE. No recursion, no globbing deeper.
//   - SYMLINKS are skipped (lstat), so a symlinked skill dir / SKILL.md cannot make the enumerator
//     escape the tree and read/emit an arbitrary path. Conservative by design; documented, not silent.
//   - JSON.stringify escapes every name/path, so a dir name with quotes/newlines/control chars cannot
//     corrupt the output shape.
//
// FAIL-SAFE, not fail-closed (the deliberate divergence from count-grillers). An ABSENT `.claude/skills/`
// is the COMMON case (no skills installed) and MUST yield an empty roster + exit 0 — advisory context is
// simply empty, and "no skills → unchanged behavior" is the SPEC's own requirement. Only a missing/naught
// TARGET repo dir (you pointed the tool at the wrong place) is an ERROR (exit 1) — fail-closed there, so a
// wrong-path run is never a silent empty (P5).
//
// Non-LLM, stdlib-only, deterministic (sorted output).
//
// Usage:  node pharn/floor/scan-installed-skills.mjs [targetDir]      (default: cwd)
// Output: {"count":<int>,"skills":[{"name":"<dir>","path":".claude/skills/<dir>/SKILL.md"},...]} on
//         stdout, sorted by name; exit 0. Exits 1 (writing NOTHING to stdout) only if targetDir itself is
//         missing / not a directory.

import { readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";

const TARGET = process.argv[2] || ".";

function fail(msg) {
  process.stderr.write("scan-installed-skills: " + msg + "\n");
  process.exit(1);
}

// Fail-CLOSED on a bad TARGET repo (wrong-path guard, P5): a missing / non-directory target is an ERROR,
// never a silent empty roster.
if (!existsSync(TARGET) || !statSync(TARGET).isDirectory()) {
  fail(`target dir not found (or not a directory): ${TARGET}`);
}

const skillsRoot = join(TARGET, ".claude", "skills");

// Is `p` a real (non-symlink) directory? lstat does NOT follow the link, so a symlinked entry returns
// isSymbolicLink() and is rejected — the enumerator never traverses a link out of the tree.
function isRealDir(p) {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// Is `p` a real (non-symlink) file?
function isRealFile(p) {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

const skills = [];

// FAIL-SAFE: an absent / non-directory `.claude/skills/` means "no skills installed" → empty roster,
// exit 0. This is the common case and the SPEC's "no skills → unchanged" path.
if (isRealDir(skillsRoot)) {
  let entries;
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const dir = join(skillsRoot, name);
    // Exactly one level: a real subdirectory directly holding a real SKILL.md file.
    if (!isRealDir(dir)) continue;
    const skillFile = join(dir, "SKILL.md");
    if (!isRealFile(skillFile)) continue;
    // path is repo-relative with forward slashes (the enumerated fact); name is the dir name.
    skills.push({ name, path: `.claude/skills/${name}/SKILL.md` });
  }
}

// Deterministic order (P5): sort by name.
skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

process.stdout.write(JSON.stringify({ count: skills.length, skills }) + "\n");
process.exit(0);
