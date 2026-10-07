/** Typed error for a source map that was found but cannot be parsed. */
export class MalformedSourceMapError extends Error {
  readonly code = 'ERR_MALFORMED_SOURCE_MAP';
  readonly file: string;

  constructor(file: string, reason: string) {
    super(`malformed source map for ${file}: ${reason}`);
    this.name = 'MalformedSourceMapError';
    this.file = file;
  }
}
