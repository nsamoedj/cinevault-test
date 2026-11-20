import { describe, expect, it } from 'vitest';
import { thumbnailAt } from '../src/thumbnails.js';

describe('thumbnailAt', () => {
  const thumbnails = {
    interval: 10,
    width: 320,
    height: 180,
    columns: 5,
    rows: 5,
    count: 30,
    sheets: ['/a/0.jpg', '/a/1.jpg'],
  };
  it('finds the sheet and the place of the nearest picture', () => {
    expect(thumbnailAt(thumbnails, 0)).toEqual({ sheet: '/a/0.jpg', x: 0, y: 0 });
    expect(thumbnailAt(thumbnails, 64)).toEqual({ sheet: '/a/0.jpg', x: 320, y: 180 });
    expect(thumbnailAt(thumbnails, 251)).toEqual({ sheet: '/a/1.jpg', x: 0, y: 0 });
    // After the last picture: the last one.
    expect(thumbnailAt(thumbnails, 9999)).toEqual({ sheet: '/a/1.jpg', x: 1280, y: 0 });
    expect(thumbnailAt(thumbnails, Number.NaN)).toBeUndefined();
  });
});
