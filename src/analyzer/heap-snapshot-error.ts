/** Typed error for a heap snapshot file larger than the configured byte cap. Nothing was read. */
export class HeapSnapshotTooLargeError extends RangeError {
  readonly code = 'ERR_HEAP_SNAPSHOT_TOO_LARGE';
  readonly path: string;
  readonly size: number;
  readonly maxBytes: number;

  constructor(path: string, size: number, maxBytes: number) {
    super(
      `heap snapshot ${path} is ${String(size)} bytes, over the ${String(maxBytes)}-byte limit ` +
        '(raise maxSnapshotBytes to analyse it)',
    );
    this.name = 'HeapSnapshotTooLargeError';
    this.path = path;
    this.size = size;
    this.maxBytes = maxBytes;
  }
}
