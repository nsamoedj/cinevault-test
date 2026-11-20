// How the picture fills the screen. "Automatisch" zooms in (cover) only when
// that cuts off black bars and next to nothing of the picture itself: a
// 2.39:1 film with bars baked into a 16:9 frame then fills a phone, while a
// real 16:9 picture keeps its top and bottom.

import type { PictureArea } from '@cinevault/shared';

export type FitMode = 'auto' | 'fit' | 'fill';
export type ContentFit = 'contain' | 'cover';

export const FIT_LABEL: Record<FitMode, string> = {
  auto: 'Automatisch',
  fit: 'Passend',
  fill: 'Vullen',
};

/** Zooming may cut off at most this share of the picture, per side pair. */
const MAX_LOST = 0.03;

interface Size {
  width: number;
  height: number;
}

/** The share of the picture that zooming in (cover) would cut off, at most per axis. */
export function lostToCover(frame: Size, area: PictureArea | undefined, screen: Size): number {
  if (frame.width <= 0 || frame.height <= 0 || screen.width <= 0 || screen.height <= 0) return 1;
  const picture = area ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  const scale = Math.max(screen.width / frame.width, screen.height / frame.height);
  const lost = (start: number, length: number, full: number, visible: number) => {
    const from = (full - visible) / 2;
    const to = from + visible;
    return (Math.max(0, from - start) + Math.max(0, start + length - to)) / length;
  };
  return Math.max(
    lost(picture.x, picture.width, frame.width, screen.width / scale),
    lost(picture.y, picture.height, frame.height, screen.height / scale),
  );
}

export function contentFit(
  mode: FitMode,
  frame: Size,
  area: PictureArea | undefined,
  screen: Size,
): ContentFit {
  if (mode === 'fit') return 'contain';
  if (mode === 'fill') return 'cover';
  return lostToCover(frame, area, screen) <= MAX_LOST ? 'cover' : 'contain';
}
