import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import type { AgentSample } from '../agent/index.js';
import {
  addSample,
  closeWindow,
  openWindow,
  windowStartOf,
  type WindowAccumulator,
} from './window.js';

export type WindowAggregatorOptions = { windowMs: number };

/** Object-mode Transform: AgentSample in, AggregatedWindow out, one window per aligned interval. */
export function createWindowAggregator(options: WindowAggregatorOptions): Transform {
  const { windowMs } = options;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a positive safe integer');
  }
  let open: WindowAccumulator | undefined;

  return new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
      try {
        const sample = chunk as AgentSample;
        if (typeof sample.timestamp !== 'number' || !Number.isFinite(sample.timestamp)) {
          callback(new TypeError('sample.timestamp must be a finite number'));
          return;
        }
        const start = windowStartOf(sample.timestamp, windowMs);
        if (open === undefined) {
          open = openWindow(start);
        } else if (start < open.start) {
          // Late: a closed window is never re-opened.
          open.late += 1;
          callback();
          return;
        } else if (start > open.start) {
          this.push(closeWindow(open, windowMs));
          open = openWindow(start);
        }
        addSample(open, sample);
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(callback: TransformCallback): void {
      try {
        if (open !== undefined) {
          this.push(closeWindow(open, windowMs));
          open = undefined;
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
