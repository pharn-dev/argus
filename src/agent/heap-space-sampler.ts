/// <reference types="node" />
import v8 from 'node:v8';

/** One V8 heap space, all sizes integer bytes (V8's field names kept as reported). */
export type HeapSpaceEntry = {
  name: string;
  space_size: number;
  space_used_size: number;
  space_available_size: number;
  physical_space_size: number;
};

/** Named heap spaces in V8's order. */
export type HeapSpaceSample = HeapSpaceEntry[];

function toNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(value), 0), Number.MAX_SAFE_INTEGER);
}

export function sampleHeapSpaces(): HeapSpaceSample {
  return v8.getHeapSpaceStatistics().map((space) => ({
    name: space.space_name,
    space_size: toNonNegativeInt(space.space_size),
    space_used_size: toNonNegativeInt(space.space_used_size),
    space_available_size: toNonNegativeInt(space.space_available_size),
    physical_space_size: toNonNegativeInt(space.physical_space_size),
  }));
}
