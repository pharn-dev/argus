// One version's section of a CHANGELOG, as the GitHub Release notes.
//
// Shared by scripts/release-notes.mjs (run by publish.yml's unprivileged `build` job, before
// `npm ci`) and scripts/check-release-consistency.mjs (run by `npm test` on every PR), so a version
// bump that forgot its CHANGELOG section fails the PR, not the post-merge release.
//
// The section is the body under the ONE heading that starts `## [<version>]` (any date suffix after
// it), up to the next `## ` heading or the link-reference block at the bottom of the file. The
// version is compared as a literal string with `startsWith`, never put into a RegExp, and must be a
// plain `X.Y.Z`. Node core only; this module reads nothing and never throws on bad input.

/** The one shape a release version may take. */
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const LINK_REF_RE = /^\[[^\]]+\]:\s/;

/**
 * @param {string} text the CHANGELOG file contents
 * @param {string} version a plain X.Y.Z
 * @returns {{ ok: true, notes: string } | { ok: false, error: string }}
 */
export function changelogSection(text, version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    return {
      ok: false,
      error: `version must be X.Y.Z, got ${JSON.stringify(version ?? null)}`,
    };
  }
  if (typeof text !== 'string') {
    return { ok: false, error: 'the changelog text is not a string' };
  }

  const lines = text.split(/\r\n|\r|\n/);
  const heading = `## [${version}]`;
  const starts = [];
  lines.forEach((line, index) => {
    if (line.startsWith(heading)) starts.push(index);
  });
  if (starts.length === 0) {
    return { ok: false, error: `no "${heading}" heading in the changelog` };
  }
  if (starts.length > 1) {
    return {
      ok: false,
      error: `"${heading}" appears ${starts.length} times in the changelog`,
    };
  }

  const body = [];
  for (const line of lines.slice(starts[0] + 1)) {
    if (line.startsWith('## ') || LINK_REF_RE.test(line)) break;
    body.push(line);
  }
  const notes = body.join('\n').trim();
  if (notes === '') {
    return { ok: false, error: `the "${heading}" section is empty` };
  }
  return { ok: true, notes };
}
