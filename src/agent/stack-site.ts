import { fileURLToPath } from 'node:url';

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?\s*$/;

/**
 * Return `file:line` for the first stack frame that is not Node-internal, native, anonymous or in
 * `skipFiles`. The first line of the stack (the message) is ignored. Returns undefined when no frame remains.
 */
export function siteFromStack(stack: string, skipFiles: ReadonlySet<string>): string | undefined {
  const lines = stack.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const match = FRAME.exec(lines[i] ?? '');
    if (match === null) {
      continue;
    }
    let file = match[1] ?? '';
    const line = match[2] ?? '';
    if (file.startsWith('node:') || file.startsWith('internal/')) {
      continue;
    }
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        // A malformed file URL is kept as written; it still names a site.
      }
    }
    if (file === 'native' || file === '<anonymous>' || skipFiles.has(file)) {
      continue;
    }
    return `${file}:${line}`;
  }
  return undefined;
}
