import { describe, expect, it } from 'vitest';
import { nearest } from '../src/spatialNav.js';

const rect = (left: number, top: number, width = 100, height = 150) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

/** A row of posters with a row below it, as on the start page. */
function grid() {
  const cells: { element: HTMLElement; rect: DOMRect }[] = [];
  for (const [row, top] of [0, 200].entries()) {
    for (let col = 0; col < 4; col++) {
      const element = document.createElement('a');
      element.id = `r${row}c${col}`;
      cells.push({ element, rect: rect(col * 120, top) });
    }
  }
  return cells;
}

describe('nearest (arrow keys on a TV remote)', () => {
  const cells = grid();
  const from = (id: string) => cells.find((c) => c.element.id === id)?.rect as DOMRect;
  const others = (id: string) => cells.filter((c) => c.element.id !== id);

  it('moves along a row and between rows', () => {
    expect(nearest(from('r0c1'), 'right', others('r0c1'))?.id).toBe('r0c2');
    expect(nearest(from('r0c1'), 'left', others('r0c1'))?.id).toBe('r0c0');
    expect(nearest(from('r0c2'), 'down', others('r0c2'))?.id).toBe('r1c2');
    expect(nearest(from('r1c3'), 'up', others('r1c3'))?.id).toBe('r0c3');
  });

  it('stops at the edge', () => {
    expect(nearest(from('r0c3'), 'right', others('r0c3'))).toBeUndefined();
    expect(nearest(from('r0c0'), 'up', others('r0c0'))).toBeUndefined();
  });

  it('prefers what is straight below over what is closer but to the side', () => {
    const below = document.createElement('button');
    below.id = 'below';
    const side = cells.find((c) => c.element.id === 'r1c3') as (typeof cells)[number];
    const candidates = [side, { element: below, rect: rect(0, 500, 100, 40) }];
    expect(nearest(from('r0c0'), 'down', candidates)?.id).toBe('below');
  });
});
