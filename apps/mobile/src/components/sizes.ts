import { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';
import { isCar, px } from '../car';
import { gutter } from '../theme';

/** Width of the menu next to the screens (the rail on the left in a car), 0 without one. */
export const SideMenuWidth = createContext(0);

/** Width of the screen next to the menu. */
export function useContentWidth(): number {
  return useWindowDimensions().width - useContext(SideMenuWidth);
}

/** Card widths: about three posters on a phone, more on a tablet. */
export function useCardWidths() {
  const width = useContentWidth();
  // A car's screen is wide but low: smaller cards, so a row fits under the billboard.
  if (isCar) return { poster: px(150), landscape: px(290) };
  const poster = Math.round(Math.min(190, Math.max(108, (width - gutter * 2) / 3.25)));
  const landscape = Math.round(Math.min(380, Math.max(240, (width - gutter * 2) / 1.35)));
  return { poster, landscape };
}

/** Columns and card width for a grid of posters (or, with a wider card, of anything). */
export function useGrid(minWidth = 104, minColumns = 3) {
  const width = useContentWidth();
  // In a car the cards, gaps and margins are drawn bigger (px).
  const gap = px(10);
  const inner = width - px(gutter) * 2;
  const columns = Math.max(minColumns, Math.floor((inner + gap) / (px(minWidth) + gap)));
  const cardWidth = Math.floor((inner - gap * (columns - 1)) / columns);
  return { columns, cardWidth, gap };
}

/** "4K", "HDR10", "Dolby Vision": what the file offers. */
export function qualityBadges(height?: number, hdrFormat?: string): string[] {
  const badges: string[] = [];
  if (height && height > 1600) badges.push('4K');
  else if (height && height > 900) badges.push('HD');
  if (hdrFormat) badges.push(hdrFormat === 'DV' ? 'Dolby Vision' : hdrFormat);
  return badges;
}
