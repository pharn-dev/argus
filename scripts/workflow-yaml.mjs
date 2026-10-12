// A tiny, fail-closed reader for the YAML subset this repository's GitHub workflow files use.
//
// scripts/check-publish-workflow.mjs reads .github/workflows/publish.yml through it, so the check
// has no dependency: the root package.json keeps no runtime dependencies. It supports exactly:
//   - block mappings and block sequences (including `- key: value` items),
//   - plain, single-quoted and double-quoted scalars on one line (a plain scalar may continue on
//     more-indented lines, which is how Prettier folds a long one),
//   - `|` and `|-` literal block scalars,
//   - flow sequences of scalars on one line (`[main]`, `[gate, build]`),
//   - full-line comments and trailing ` #` comments.
// Anything else THROWS with a positioned message instead of being misread: tabs in indentation,
// anchors, aliases, tags, `>` folded scalars, flow mappings, multi-line quoted scalars, multiple
// documents, directives, duplicate keys, and a sequence at the same indentation as its key.
// Every scalar comes back as a string (no YAML 1.1 boolean or number coercion, so the key `on`
// stays "on" and `false` stays "false"); an empty value is null. Mappings have a null prototype.
// Node core only (it imports nothing).

const KEY_RE =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[\]{}&*!|>%@`,:-][^:]*?)\s*:(?:[ ]+(.*))?$/;
const SEQ_RE = /^\s*-(\s|$)/;
const ESCAPES = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  0: '\0',
};

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseWorkflowYaml(text) {
  if (typeof text !== 'string') throw new Error('the workflow text is not a string');
  const lines = text.split(/\r\n|\r|\n/);
  const n = lines.length;
  let pos = 0;

  const fail = (index, message) => {
    throw new Error(`line ${index + 1}: ${message}`);
  };
  const indentOf = (line) => line.length - line.trimStart().length;
  const skippable = (line) => {
    const t = line.trim();
    return t === '' || t.startsWith('#');
  };
  const skip = () => {
    while (pos < n && skippable(lines[pos])) pos += 1;
  };

  lines.forEach((line, i) => {
    if (/^(---|\.\.\.)(\s|$)/.test(line)) fail(i, 'document markers are not supported');
    if (line.startsWith('%')) fail(i, 'directives are not supported');
    if (/^ *\t/.test(line)) fail(i, 'a tab in indentation is not supported');
  });

  const stripComment = (s) => {
    const at = s.search(/\s#/);
    return (at === -1 ? s : s.slice(0, at)).trim();
  };

  function unquoteDouble(r, index) {
    let out = '';
    let i = 1;
    for (; i < r.length; i += 1) {
      const c = r[i];
      if (c === '"') break;
      if (c === '\\') {
        i += 1;
        const mapped = ESCAPES[r[i]];
        if (mapped === undefined) fail(index, `unsupported escape \\${r[i] ?? ''}`);
        out += mapped;
      } else {
        out += c;
      }
    }
    if (r[i] !== '"') fail(index, 'a double-quoted scalar must close on the same line');
    return { value: out, rest: r.slice(i + 1) };
  }

  function unquoteSingle(r, index) {
    let out = '';
    let i = 1;
    for (; i < r.length; i += 1) {
      if (r[i] === "'") {
        if (r[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        break;
      }
      out += r[i];
    }
    if (r[i] !== "'") fail(index, 'a single-quoted scalar must close on the same line');
    return { value: out, rest: r.slice(i + 1) };
  }

  const requireTail = (rest, index) => {
    if (!/^(\s+#.*)?\s*$/.test(rest)) fail(index, 'unexpected text after a quoted scalar');
  };

  function parseKey(raw, index) {
    let key = raw;
    if (raw.startsWith('"')) key = unquoteDouble(raw, index).value;
    else if (raw.startsWith("'")) key = unquoteSingle(raw, index).value;
    key = key.trim();
    if (key === '__proto__') fail(index, 'the key __proto__ is not supported');
    return key;
  }

  function parseFlowSequence(r, index) {
    const m = /^\[([^[\]{}]*)\]\s*(#.*)?$/.exec(r);
    if (!m) fail(index, 'only a one-line flow sequence of scalars is supported');
    const items = [];
    let current = '';
    let quote = null;
    for (const c of m[1]) {
      if (quote) {
        current += c;
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
        current += c;
      } else if (c === ',') {
        items.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    if (quote) fail(index, 'an unterminated quote in a flow sequence');
    if (current.trim() !== '' || items.length > 0) items.push(current);
    return items
      .map((item, k) => ({ item: item.trim(), last: k === items.length - 1 }))
      .filter(({ item, last }) => !(item === '' && last && items.length > 1))
      .map(({ item }) => {
        if (item === '') fail(index, 'an empty item in a flow sequence');
        if (item.startsWith('"')) {
          const { value, rest } = unquoteDouble(item, index);
          requireTail(rest, index);
          return value;
        }
        if (item.startsWith("'")) {
          const { value, rest } = unquoteSingle(item, index);
          requireTail(rest, index);
          return value;
        }
        return item;
      });
  }

  // `r` is the value text after `key:` / `- ` (comment possibly attached), on line `index`;
  // `indent` is the indentation of the owning mapping, for plain-scalar continuation lines.
  function parseInline(r, index, indent) {
    const c = r[0];
    if (c === '[') return parseFlowSequence(r, index);
    if (c === '"') {
      const { value, rest } = unquoteDouble(r, index);
      requireTail(rest, index);
      return value;
    }
    if (c === "'") {
      const { value, rest } = unquoteSingle(r, index);
      requireTail(rest, index);
      return value;
    }
    if ('{&*!>%@`|'.includes(c)) fail(index, `a value starting with "${c}" is not supported`);
    let value = stripComment(r);
    if (/:(\s|$)/.test(value)) fail(index, 'a plain scalar may not contain ": "');
    while (pos < n && !skippable(lines[pos]) && indentOf(lines[pos]) > indent) {
      const extra = stripComment(lines[pos]);
      if (/:(\s|$)/.test(extra) || SEQ_RE.test(extra)) {
        fail(pos, 'unexpected structure inside a plain scalar');
      }
      value = `${value} ${extra}`;
      pos += 1;
    }
    return value;
  }

  function parseLiteral(r, index, indent) {
    const header = /^\|(-?)\s*(#.*)?$/.exec(r);
    if (!header) fail(index, 'only the "|" and "|-" block scalar styles are supported');
    const content = [];
    let blockIndent = null;
    while (pos < n) {
      const line = lines[pos];
      if (line.trim() === '') {
        content.push('');
        pos += 1;
        continue;
      }
      const ind = indentOf(line);
      if (blockIndent === null) {
        if (ind <= indent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) break;
      content.push(line.slice(blockIndent));
      pos += 1;
    }
    while (content.length > 0 && content[content.length - 1] === '') content.pop();
    if (content.length === 0) return '';
    return content.join('\n') + (header[1] === '-' ? '' : '\n');
  }

  // A key with no inline value: a nested block, a scalar folded onto the next lines, or null.
  function parseNested(indent) {
    skip();
    if (pos >= n) return null;
    const line = lines[pos];
    const ind = indentOf(line);
    if (ind > indent) {
      if (SEQ_RE.test(line)) return parseSeq(ind);
      if (KEY_RE.test(line.slice(ind))) return parseMap(ind);
      const index = pos;
      pos += 1;
      return parseInline(line.trim(), index, indent);
    }
    if (ind === indent && SEQ_RE.test(line)) {
      fail(pos, 'a sequence at the same indentation as its key is not supported');
    }
    return null;
  }

  function parseMap(indent) {
    const out = Object.create(null);
    for (;;) {
      skip();
      if (pos >= n) break;
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) fail(pos, 'unexpected indentation');
      if (SEQ_RE.test(line)) fail(pos, 'a sequence item where a mapping key was expected');
      const m = KEY_RE.exec(line.slice(indent));
      if (!m) fail(pos, 'expected "key: value"');
      const key = parseKey(m[1], pos);
      if (key in out) fail(pos, `duplicate key "${key}"`);
      const index = pos;
      pos += 1;
      const rest = (m[2] ?? '').trim();
      if (rest.startsWith('|')) {
        out[key] = parseLiteral(rest, index, indent);
      } else if (rest === '' || rest.startsWith('#')) {
        out[key] = parseNested(indent);
      } else {
        out[key] = parseInline(rest, index, indent);
      }
    }
    return out;
  }

  function parseSeq(indent) {
    const out = [];
    for (;;) {
      skip();
      if (pos >= n) break;
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) fail(pos, 'unexpected indentation');
      if (!SEQ_RE.test(line)) fail(pos, 'expected a "- " sequence item');
      const afterDash = line.slice(indent + 1);
      const rest = afterDash.trimStart();
      const keyCol = indent + 1 + (afterDash.length - rest.length);
      if (rest === '' || rest.startsWith('#')) {
        pos += 1;
        skip();
        out.push(
          pos < n && indentOf(lines[pos]) > indent
            ? SEQ_RE.test(lines[pos])
              ? parseSeq(indentOf(lines[pos]))
              : parseMap(indentOf(lines[pos]))
            : null,
        );
      } else if (KEY_RE.test(rest)) {
        lines[pos] = ' '.repeat(keyCol) + rest;
        out.push(parseMap(keyCol));
      } else {
        const index = pos;
        pos += 1;
        out.push(parseInline(rest, index, indent));
      }
    }
    return out;
  }

  skip();
  if (pos >= n) return Object.create(null);
  const top = indentOf(lines[pos]);
  if (SEQ_RE.test(lines[pos])) fail(pos, 'a workflow file must be a mapping');
  const document = parseMap(top);
  skip();
  if (pos < n) fail(pos, 'unexpected content after the document');
  return document;
}
