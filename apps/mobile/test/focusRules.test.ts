import { describe, expect, it } from 'vitest';
import {
  keyedRecently,
  remoteKeyOf,
  rowFocusTarget,
  sectionNeighbors,
  unexplainedFocus,
  wrongLine,
} from '../src/tv/focusRules';

describe('TV focus rules', () => {
  it('knows a move of the viewer from one Android made itself', () => {
    const down = { key: 'down', at: 1_000 };
    expect(keyedRecently(down, ['up', 'down'], 1_300)).toBe(true);
    expect(keyedRecently(down, ['right'], 1_300)).toBe(false);
    expect(keyedRecently(down, ['down'], 2_000)).toBe(false);
    expect(keyedRecently(undefined, ['down'], 2_000)).toBe(false);
    // Just after a key: the viewer's move.
    expect(unexplainedFocus(down, 0, 1_300)).toBe(false);
    // Long after it (a refetch replaced the focused card): Android's.
    expect(unexplainedFocus(down, 0, 5_000)).toBe(true);
    expect(unexplainedFocus(undefined, 0, 5_000)).toBe(true);
    // The app's own focus call (back to a screen, a picker that closed).
    expect(unexplainedFocus(down, 6_000, 5_000)).toBe(false);
  });

  it('goes into a row at the card drawn under where the focus was', () => {
    const row = { length: 20, enteredVertically: true, step: 100, itemWidth: 90 };
    // From the left edge of a slid row into a row slid to its 3rd card: that card,
    // wherever Android landed (the 8th, where the 8th of the other row is laid out).
    expect(rowFocusTarget({ ...row, index: 8, shift: 300, from: 45 })).toBe(3);
    expect(rowFocusTarget({ ...row, index: 8, shift: 0, from: 45 })).toBe(0);
    // From the 3rd card of a short row that doesn't slide, into a short row it
    // last left at its 2nd card: straight down, not one to the right
    // (eigenaar, 2026-10-28).
    expect(rowFocusTarget({ ...row, length: 4, index: 2, shift: 0, from: 245 })).toBe(2);
    expect(rowFocusTarget({ ...row, length: 4, index: 2, shift: 0, from: 45 })).toBe(0);
    // From a button (not in a row): the card drawn under Android's pick.
    expect(rowFocusTarget({ ...row, index: 1, shift: 0 })).toBe(1);
    expect(rowFocusTarget({ ...row, index: 1, shift: 500 })).toBe(6);
    // Wider cards below narrower ones: the nearest middle.
    expect(
      rowFocusTarget({
        length: 10,
        enteredVertically: true,
        step: 180,
        itemWidth: 170,
        index: 0,
        shift: 0,
        from: 400,
      }),
    ).toBe(2);
    // Fewer cards now than before (a refetch): the last one.
    expect(rowFocusTarget({ ...row, length: 4, index: 1, shift: 900, from: 45 })).toBe(3);
    // Left and right within the row, or back to a screen: where the focus went.
    expect(rowFocusTarget({ ...row, enteredVertically: false, index: 8, shift: 0, from: 45 })).toBe(
      8,
    );
  });
});

describe('sectionNeighbors', () => {
  // A page: the billboard's buttons, a short row, a long row (in that order).
  const entries = {
    rowLong: { order: 1, tag: 30 },
    top: { order: -1, tag: 10 },
    rowShort: { order: 0, tag: 20 },
  };

  it('goes to the line right above and below, whatever the layout search would find', () => {
    // Down from far right in the long row's neighbour never skips the short row.
    expect(sectionNeighbors(entries, 'top')).toEqual({ up: 'self', down: 20, downOrder: 0 });
    expect(sectionNeighbors(entries, 'rowShort')).toEqual({
      up: 10,
      down: 30,
      upOrder: -1,
      downOrder: 1,
    });
  });

  it('stays at the top and bottom of the page instead of going into the menu', () => {
    expect(sectionNeighbors(entries, 'top')?.up).toBe('self');
    expect(sectionNeighbors(entries, 'rowLong')?.down).toBe('self');
  });

  it('knows nothing of a line without a view yet', () => {
    expect(sectionNeighbors(entries, 'gone')).toBeUndefined();
    expect(sectionNeighbors({ only: { order: 3, tag: 5 } }, 'only')).toEqual({
      up: 'self',
      down: 'self',
    });
  });
});

describe('remoteKeyOf', () => {
  it('counts presses and releases of the remote, not the focus changes on the same channel', () => {
    expect(remoteKeyOf({ eventType: 'up', eventKeyAction: 0 })).toBe('up');
    expect(remoteKeyOf({ eventType: 'down', eventKeyAction: 1 })).toBe('down');
    // ReactAndroidHWInputDeviceHelper.onFocusChanged: "blur" and "focus" with -1.
    expect(remoteKeyOf({ eventType: 'focus', eventKeyAction: -1 })).toBeUndefined();
    expect(remoteKeyOf({ eventType: 'blur', eventKeyAction: -1 })).toBeUndefined();
    expect(remoteKeyOf({ eventType: 'playPause', eventKeyAction: 0 })).toBeUndefined();
  });
});

describe('wrongLine', () => {
  const page = {};
  const row3 = { stack: page, order: 3, upOrder: 2, downOrder: 4, upTag: 20, downTag: 40 };

  it('sends "up" that landed on the billboard to the row above', () => {
    expect(wrongLine('up', row3, { stack: page, order: -1 })).toBe(20);
    expect(wrongLine('down', row3, { stack: page, order: 7 })).toBe(40);
  });

  it('leaves the focus where it belongs', () => {
    expect(wrongLine('up', row3, { stack: page, order: 2 })).toBeUndefined();
    expect(wrongLine('down', row3, { stack: page, order: 4 })).toBeUndefined();
    // Within the line (left, right, a line of chips that wraps).
    expect(wrongLine('up', row3, { stack: page, order: 3 })).toBeUndefined();
    expect(wrongLine('right', row3, { stack: page, order: 0 })).toBeUndefined();
    // Another page, or no line (the menu).
    expect(wrongLine('up', row3, { stack: {}, order: -1 })).toBeUndefined();
    expect(wrongLine('up', row3, undefined)).toBeUndefined();
  });

  it('stays at the top of a page', () => {
    const top = { stack: page, order: -1, downOrder: 0, upTag: 5, downTag: 20 };
    expect(wrongLine('up', top, { stack: page, order: 3 })).toBe(5);
  });
});
