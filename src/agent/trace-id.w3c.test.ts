import { describe, expect, it } from 'vitest';
import { parseTraceparent } from './trace-id.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const ZERO_PARENT_ID = '0000000000000000';

describe('parseTraceparent — W3C Trace Context rules (F-17)', () => {
  it('accepts a valid version-00 header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01`)).toBe(TRACE_ID);
  });

  it('rejects an all-zero parent-id, so the request starts a new trace', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${ZERO_PARENT_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`01-${TRACE_ID}-${ZERO_PARENT_ID}-01`)).toBeUndefined();
  });

  it('parses a higher version (01) with the version-00 layout', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01`)).toBe(TRACE_ID);
    expect(parseTraceparent(`cc-${TRACE_ID}-${PARENT_ID}-00`)).toBe(TRACE_ID);
  });

  it('parses a higher version (01) that appends fields after a dash', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01-future-field`)).toBe(TRACE_ID);
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01-`)).toBe(TRACE_ID);
  });

  it('rejects a higher version whose extra characters do not start with a dash', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01x`)).toBeUndefined();
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-0`)).toBeUndefined();
  });

  it('rejects trailing fields on version 00, version ff, and a non-hex version', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01-extra`)).toBeUndefined();
    expect(parseTraceparent(`ff-${TRACE_ID}-${PARENT_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`zz-${TRACE_ID}-${PARENT_ID}-01`)).toBeUndefined();
  });

  it('still rejects an all-zero trace-id, malformed and duplicated values', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${PARENT_ID}-01`)).toBeUndefined();
    expect(parseTraceparent('not-a-traceparent')).toBeUndefined();
    expect(parseTraceparent([`00-${TRACE_ID}-${PARENT_ID}-01`])).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });
});
