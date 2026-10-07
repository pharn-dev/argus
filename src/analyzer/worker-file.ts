import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function moduleDirectory(): string {
  // `node -e` defines a relative `__dirname` (".") even in ESM, so only an absolute one is trusted.
  if (typeof __dirname === 'string' && isAbsolute(__dirname)) return __dirname;
  // ESM build: `import.meta` cannot appear in the CommonJS output, so read this call site instead.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- saved only to be restored in finally
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  let fileName: string | null | undefined;
  try {
    Error.stackTraceLimit = 10;
    Error.prepareStackTrace = (_, sites) => sites;
    const sites = new Error().stack as unknown as NodeJS.CallSite[] | undefined;
    fileName = sites?.[0]?.getFileName();
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
  if (typeof fileName !== 'string' || fileName === '') {
    throw new Error('analyzer could not locate its worker directory');
  }
  return dirname(fileName.startsWith('file:') ? fileURLToPath(fileName) : fileName);
}

/** Absolute path of a worker file bundled with the analyzer (`.js` in builds, `.ts` in source). */
export function resolveBundledWorkerFile(baseName: string): string {
  const dir = moduleDirectory();
  const candidates = [
    join(dir, 'workers', `${baseName}.js`),
    join(dir, 'workers', `${baseName}.ts`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`analyzer worker file not found; tried: ${candidates.join(', ')}`);
}
