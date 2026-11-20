// Finding the timeline preview for a moment in the sheets of the server.

import type { Thumbnails } from './index.js';

/** Where the picture for `seconds` is: its sheet, and its place in pixels. */
export function thumbnailAt(
  thumbnails: Thumbnails,
  seconds: number,
): { sheet: string; x: number; y: number } | undefined {
  const { interval, columns, rows, count, sheets } = thumbnails;
  if (count === 0 || !(seconds >= 0)) return undefined;
  const index = Math.min(count - 1, Math.round(seconds / interval));
  const perSheet = columns * rows;
  const sheet = sheets[Math.floor(index / perSheet)];
  if (!sheet) return undefined;
  const place = index % perSheet;
  return {
    sheet,
    x: (place % columns) * thumbnails.width,
    y: Math.floor(place / columns) * thumbnails.height,
  };
}
