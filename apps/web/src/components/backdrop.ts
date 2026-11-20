import { largeImage } from '@cinevault/shared';
import { isTv } from '../device.js';

/** A screen that shows more than the 1280 px of a w1280 backdrop: TVs and big, sharp monitors. */
function bigScreen(): boolean {
  if (isTv()) return true;
  if (typeof window === 'undefined') return false;
  return window.screen.width * (window.devicePixelRatio || 1) >= 2560;
}

/** The backdrop at full size on big screens (4K TVs), else as it is. */
export function backdropSrc(url: string | undefined): string | undefined {
  return bigScreen() ? largeImage(url) : url;
}
