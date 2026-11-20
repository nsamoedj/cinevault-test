// CineVault's icons (the same shapes as the web app), 24×24 in the given colour.

import type { ReactNode } from 'react';
import Svg, { Circle, G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { px } from '../car';
import { colors } from '../theme';

type Draw = (color: string) => ReactNode;

const line = (color: string) =>
  ({
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }) as const;

const ICONS = {
  play: (c) => (
    <Path
      d="M7 4.6v14.8a1 1 0 0 0 1.5.86l12.2-7.4a1 1 0 0 0 0-1.72L8.5 3.74A1 1 0 0 0 7 4.6Z"
      fill={c}
    />
  ),
  pause: (c) => (
    <G fill={c}>
      <Rect x={6} y={4} width={4} height={16} rx={1.2} />
      <Rect x={14} y={4} width={4} height={16} rx={1.2} />
    </G>
  ),
  volume: (c) => (
    <G>
      <Path
        d="M4 9.2v5.6c0 .5.4.9.9.9H8l4.4 3.7a.8.8 0 0 0 1.3-.6V5.2a.8.8 0 0 0-1.3-.6L8 8.3H4.9c-.5 0-.9.4-.9.9Z"
        fill={c}
      />
      <Path {...line(c)} d="M17 8.5a5 5 0 0 1 0 7M19.6 5.6a9 9 0 0 1 0 12.8" />
    </G>
  ),
  replay10: (c) => (
    <G>
      <Path {...line(c)} d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <Path {...line(c)} d="M3 3.5v4.2h4.2" />
      <SvgText x={12.4} y={15.6} fontSize={7.5} fontWeight="700" textAnchor="middle" fill={c}>
        10
      </SvgText>
    </G>
  ),
  forward10: (c) => (
    <G>
      <Path {...line(c)} d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <Path {...line(c)} d="M21 3.5v4.2h-4.2" />
      <SvgText x={11.6} y={15.6} fontSize={7.5} fontWeight="700" textAnchor="middle" fill={c}>
        10
      </SvgText>
    </G>
  ),
  next: (c) => (
    <G fill={c}>
      <Path d="M5 5.2v13.6a.9.9 0 0 0 1.4.75l9.7-6.8a.9.9 0 0 0 0-1.5L6.4 4.45A.9.9 0 0 0 5 5.2Z" />
      <Rect x={17} y={4.5} width={2.6} height={15} rx={1} />
    </G>
  ),
  subtitles: (c) => (
    <G>
      <Rect {...line(c)} x={3} y={5} width={18} height={14} rx={2.5} />
      <Path {...line(c)} d="M7 12.5h3M13 12.5h4M7 15.5h6M15.5 15.5H17" />
    </G>
  ),
  settings: (c) => (
    <G {...line(c)}>
      <Path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <Circle cx={15} cy={7} r={2} />
      <Circle cx={9} cy={17} r={2} />
    </G>
  ),
  lock: (c) => (
    <G {...line(c)}>
      <Rect x={5} y={10.5} width={14} height={10} rx={2.2} />
      <Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5" />
    </G>
  ),
  unlock: (c) => (
    <G {...line(c)}>
      <Rect x={5} y={10.5} width={14} height={10} rx={2.2} />
      <Path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7M12 14.5v2.5" />
    </G>
  ),
  back: (c) => <Path {...line(c)} d="M19 12H5M11 6l-6 6 6 6" />,
  chevronRight: (c) => <Path {...line(c)} d="m9 5 7 7-7 7" />,
  chevronDown: (c) => <Path {...line(c)} d="m6 9 6 6 6-6" />,
  chevronUp: (c) => <Path {...line(c)} d="m6 15 6-6 6 6" />,
  check: (c) => <Path {...line(c)} strokeWidth={2.4} d="m5 12.5 4.5 4.5L19 7.5" />,
  plus: (c) => <Path {...line(c)} d="M12 5v14M5 12h14" />,
  close: (c) => <Path {...line(c)} d="M6 6l12 12M18 6 6 18" />,
  trash: (c) => (
    <G {...line(c)}>
      <Path d="M4 7h16M10 11v6M14 11v6" />
      <Path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </G>
  ),
  search: (c) => (
    <G {...line(c)}>
      <Circle cx={11} cy={11} r={6.5} />
      <Path d="m20 20-4.4-4.4" />
    </G>
  ),
  home: (c) => (
    <Path
      {...line(c)}
      d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z"
    />
  ),
  film: (c) => (
    <G {...line(c)}>
      <Rect x={3} y={4} width={18} height={16} rx={2.5} />
      <Path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" />
    </G>
  ),
  bell: (c) => (
    <G {...line(c)}>
      <Path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2Z" />
      <Path d="M10 21h4" />
    </G>
  ),
  calendar: (c) => (
    <G {...line(c)}>
      <Rect x={3.5} y={5} width={17} height={15.5} rx={2.5} />
      <Path d="M3.5 10h17M8 3v4M16 3v4" />
    </G>
  ),
  share: (c) => (
    <G {...line(c)}>
      <Path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" />
      <Path d="M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12" />
    </G>
  ),
  tv: (c) => (
    <G {...line(c)}>
      <Rect x={3} y={5} width={18} height={12} rx={2} />
      <Path d="M8 20h8M12 17v3" />
    </G>
  ),
  compass: (c) => (
    <G {...line(c)}>
      <Circle cx={12} cy={12} r={9} />
      <Path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </G>
  ),
  sparkle: (c) => (
    <G {...line(c)}>
      <Path d="M12 3.5 13.9 10l6.6 2-6.6 2L12 20.5 10.1 14 3.5 12l6.6-2L12 3.5Z" />
      <Path d="M19 3.5v3M17.5 5h3" />
    </G>
  ),
  sort: (c) => (
    <Path {...line(c)} d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5" />
  ),
  user: (c) => (
    <G {...line(c)}>
      <Circle cx={12} cy={8.5} r={3.8} />
      <Path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </G>
  ),
  info: (c) => (
    <G {...line(c)}>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 11v5.5M12 7.6v.1" />
    </G>
  ),
  star: (c) => (
    <Path
      d="m12 3.6 2.5 5.3 5.8.7-4.3 4 1.1 5.8L12 16.6l-5.1 2.8L8 13.6l-4.3-4 5.8-.7L12 3.6Z"
      fill={c}
    />
  ),
  alert: (c) => (
    <G {...line(c)}>
      <Path d="M10.3 4.3 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <Path d="M12 9.5v4.5M12 17.2v.1" />
    </G>
  ),
  logout: (c) => (
    <Path {...line(c)} d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />
  ),
  server: (c) => (
    <G {...line(c)}>
      <Rect x={3} y={4} width={18} height={7} rx={2} />
      <Rect x={3} y={13} width={18} height={7} rx={2} />
      <Path d="M7 7.5h.01M7 16.5h.01" />
    </G>
  ),
  cast: (c) => (
    <G>
      <Path
        {...line(c)}
        d="M3 8V6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H14"
      />
      <Path {...line(c)} d="M3 12a7 7 0 0 1 7 7M3 15.5A3.5 3.5 0 0 1 6.5 19" />
      <Circle cx={3.5} cy={18.5} r={1.2} fill={c} />
    </G>
  ),
  pip: (c) => (
    <G>
      <Rect {...line(c)} x={3} y={5} width={18} height={14} rx={2.5} />
      <Rect x={12} y={11.5} width={6.5} height={5} rx={1} fill={c} />
    </G>
  ),
} satisfies Record<string, Draw>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 24,
  color = colors.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={px(size)} height={px(size)} viewBox="0 0 24 24" accessible={false}>
      {ICONS[name](color)}
    </Svg>
  );
}
