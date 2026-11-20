import { describe, expect, it } from 'vitest';
import { contentFit, lostToCover } from '../src/player/fit';

const phone = { width: 2400, height: 1080 }; // 20:9, landscape
const uhd = { width: 3840, height: 2160 };

describe('picture fit', () => {
  it('fills the screen when only baked-in black bars fall off', () => {
    const area = { width: 3840, height: 1608, x: 0, y: 276 }; // 2.39:1 in 16:9
    expect(lostToCover(uhd, area, phone)).toBe(0);
    expect(contentFit('auto', uhd, area, phone)).toBe('cover');
  });

  it('keeps a real 16:9 picture whole, and a 2.39:1 frame without bars', () => {
    expect(lostToCover(uhd, undefined, phone)).toBeCloseTo(0.2, 2);
    expect(contentFit('auto', uhd, undefined, phone)).toBe('contain');
    expect(contentFit('auto', { width: 3840, height: 1600 }, undefined, phone)).toBe('contain');
  });

  it('follows the chosen mode, and fits when the size is unknown', () => {
    expect(contentFit('fill', uhd, undefined, phone)).toBe('cover');
    expect(contentFit('fit', uhd, { width: 3840, height: 1608, x: 0, y: 276 }, phone)).toBe(
      'contain',
    );
    expect(contentFit('auto', { width: 0, height: 0 }, undefined, phone)).toBe('contain');
  });
});
