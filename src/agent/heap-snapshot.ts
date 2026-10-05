/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import v8 from 'node:v8';

export type HeapSnapshotOptions = { dir: string };
export type HeapSnapshotResult = { path: string; bytes: number };

let inProgress = false;
let counter = 0;

/**
 * Write a V8 heap snapshot into `options.dir`. Never throws synchronously: every
 * failure is a rejection. Only one snapshot may run at a time.
 */
export async function takeHeapSnapshot(options: HeapSnapshotOptions): Promise<HeapSnapshotResult> {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.dir !== 'string' ||
    options.dir === ''
  ) {
    throw new TypeError('argus: takeHeapSnapshot requires options.dir to be a non-empty string');
  }
  if (inProgress) {
    throw new Error('argus: a heap snapshot is already in progress');
  }
  inProgress = true;
  try {
    const dir = path.resolve(options.dir);
    try {
      const info = await fs.promises.stat(dir);
      if (!info.isDirectory()) {
        throw new Error('not a directory');
      }
    } catch (cause) {
      throw new Error(`argus: heap snapshot directory does not exist: ${dir}`, { cause });
    }
    try {
      await fs.promises.access(dir, fs.constants.W_OK);
    } catch (cause) {
      throw new Error(`argus: heap snapshot directory is not writable: ${dir}`, { cause });
    }

    counter += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `argus-${stamp}-${process.pid}-${counter}.heapsnapshot`);

    let writtenPath: string;
    try {
      writtenPath = v8.writeHeapSnapshot(filePath);
    } catch (cause) {
      let cleanup = '';
      try {
        await fs.promises.rm(filePath, { force: true });
      } catch (rmError) {
        cleanup = `; cleanup also failed: ${rmError instanceof Error ? rmError.message : String(rmError)}`;
      }
      throw new Error(`argus: heap snapshot write failed: ${filePath}${cleanup}`, { cause });
    }

    const { size } = await fs.promises.stat(writtenPath);
    return { path: writtenPath, bytes: Math.trunc(size) };
  } finally {
    inProgress = false;
  }
}
