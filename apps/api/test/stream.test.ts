import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/routes/stream.js';

describe('parseRange', () => {
  it.each([
    ['bytes=0-99', 1000, { start: 0, end: 99 }],
    ['bytes=500-', 1000, { start: 500, end: 999 }],
    ['bytes=-100', 1000, { start: 900, end: 999 }],
    ['bytes=-5000', 1000, { start: 0, end: 999 }],
    ['bytes=900-5000', 1000, { start: 900, end: 999 }],
  ])('%s of %i bytes', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it.each([
    ['bytes=1000-', 1000],
    ['bytes=5-2', 1000],
    ['bytes=-0', 1000],
    ['bytes=0-', 0],
  ])('%s of %i bytes is unsatisfiable', (header, size) => {
    expect(parseRange(header, size)).toBe('unsatisfiable');
  });

  it.each([undefined, 'items=0-1', 'bytes=0-1,5-6', 'bytes=-', 'bytes=abc'])(
    'ignores %s',
    (header) => {
      expect(parseRange(header, 1000)).toBeUndefined();
    },
  );
});
