// CineVault's icons: 24×24, drawn with the current text colour. Decorative by
// default (aria-hidden); buttons carry their own label.

import type { ReactNode } from 'react';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const ICONS = {
  play: (
    <path
      d="M7 4.6v14.8a1 1 0 0 0 1.5.86l12.2-7.4a1 1 0 0 0 0-1.72L8.5 3.74A1 1 0 0 0 7 4.6Z"
      fill="currentColor"
    />
  ),
  pause: (
    <g fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1.2" />
      <rect x="14" y="4" width="4" height="16" rx="1.2" />
    </g>
  ),
  replay10: (
    <g>
      <path {...stroke} d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path {...stroke} d="M3 3.5v4.2h4.2" />
      <text
        x="12.4"
        y="15.6"
        fontSize="7.5"
        fontWeight="700"
        textAnchor="middle"
        fill="currentColor"
        fontFamily="system-ui, sans-serif"
      >
        10
      </text>
    </g>
  ),
  forward10: (
    <g>
      <path {...stroke} d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path {...stroke} d="M21 3.5v4.2h-4.2" />
      <text
        x="11.6"
        y="15.6"
        fontSize="7.5"
        fontWeight="700"
        textAnchor="middle"
        fill="currentColor"
        fontFamily="system-ui, sans-serif"
      >
        10
      </text>
    </g>
  ),
  next: (
    <g>
      <path
        d="M5 5.2v13.6a.9.9 0 0 0 1.4.75l9.7-6.8a.9.9 0 0 0 0-1.5L6.4 4.45A.9.9 0 0 0 5 5.2Z"
        fill="currentColor"
      />
      <rect x="17" y="4.5" width="2.6" height="15" rx="1" fill="currentColor" />
    </g>
  ),
  volume: (
    <g>
      <path
        d="M4 9.2v5.6c0 .5.4.9.9.9H8l4.4 3.7a.8.8 0 0 0 1.3-.6V5.2a.8.8 0 0 0-1.3-.6L8 8.3H4.9c-.5 0-.9.4-.9.9Z"
        fill="currentColor"
      />
      <path {...stroke} d="M17 8.5a5 5 0 0 1 0 7M19.6 5.6a9 9 0 0 1 0 12.8" />
    </g>
  ),
  muted: (
    <g>
      <path
        d="M4 9.2v5.6c0 .5.4.9.9.9H8l4.4 3.7a.8.8 0 0 0 1.3-.6V5.2a.8.8 0 0 0-1.3-.6L8 8.3H4.9c-.5 0-.9.4-.9.9Z"
        fill="currentColor"
      />
      <path {...stroke} d="m17 9.5 5 5M22 9.5l-5 5" />
    </g>
  ),
  fullscreen: (
    <path
      {...stroke}
      d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"
    />
  ),
  exitFullscreen: (
    <path
      {...stroke}
      d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4"
    />
  ),
  subtitles: (
    <g>
      <rect {...stroke} x="3" y="5" width="18" height="14" rx="2.5" />
      <path {...stroke} d="M7 12.5h3M13 12.5h4M7 15.5h6M15.5 15.5H17" />
    </g>
  ),
  settings: (
    <g {...stroke}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </g>
  ),
  cast: (
    <g>
      <path
        {...stroke}
        d="M3 8V6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H14"
      />
      <path {...stroke} d="M3 12a7 7 0 0 1 7 7M3 15.5A3.5 3.5 0 0 1 6.5 19" />
      <circle cx="3.5" cy="18.5" r="1" fill="currentColor" />
    </g>
  ),
  pip: (
    <g>
      <rect {...stroke} x="3" y="5" width="18" height="14" rx="2.5" />
      <rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" />
    </g>
  ),
  airplay: (
    <g>
      <path
        {...stroke}
        d="M7 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"
      />
      <path d="m12 14.5 5 6H7l5-6Z" fill="currentColor" />
    </g>
  ),
  back: <path {...stroke} d="M19 12H5M11 6l-6 6 6 6" />,
  chevronLeft: <path {...stroke} d="m15 5-7 7 7 7" />,
  chevronRight: <path {...stroke} d="m9 5 7 7-7 7" />,
  chevronDown: <path {...stroke} d="m6 9 6 6 6-6" />,
  chevronUp: <path {...stroke} d="m6 15 6-6 6 6" />,
  check: <path {...stroke} strokeWidth={2.4} d="m5 12.5 4.5 4.5L19 7.5" />,
  plus: <path {...stroke} d="M12 5v14M5 12h14" />,
  close: <path {...stroke} d="M6 6l12 12M18 6 6 18" />,
  search: (
    <g {...stroke}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </g>
  ),
  home: (
    <path
      {...stroke}
      d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z"
    />
  ),
  film: (
    <g {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" />
    </g>
  ),
  bell: (
    <g {...stroke}>
      <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2Z" />
      <path d="M10 21h4" />
    </g>
  ),
  calendar: (
    <g {...stroke}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </g>
  ),
  copy: (
    <g {...stroke}>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
    </g>
  ),
  tv: (
    <g {...stroke}>
      <rect x="3" y="5" width="18" height="12" rx="2.5" />
      <path d="M8 21h8M12 17v4" />
    </g>
  ),
  compass: (
    <g {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </g>
  ),
  sparkles: (
    <g>
      <path
        d="M10 3.5c.5 3.6 2.4 5.5 6 6-3.6.5-5.5 2.4-6 6-.5-3.6-2.4-5.5-6-6 3.6-.5 5.5-2.4 6-6Z"
        fill="currentColor"
      />
      <path
        d="M18 13.5c.3 1.9 1.1 2.7 3 3-1.9.3-2.7 1.1-3 3-.3-1.9-1.1-2.7-3-3 1.9-.3 2.7-1.1 3-3Z"
        fill="currentColor"
      />
    </g>
  ),
  info: (
    <g {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </g>
  ),
  star: (
    <path
      d="m12 3.6 2.5 5.3 5.8.7-4.3 4 1.1 5.8L12 16.6l-5.1 2.8L8 13.6l-4.3-4 5.8-.7L12 3.6Z"
      fill="currentColor"
    />
  ),
  trash: (
    <g {...stroke}>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </g>
  ),
  more: (
    <g fill="currentColor">
      <circle cx="5.5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="18.5" cy="12" r="1.8" />
    </g>
  ),
  user: (
    <g {...stroke}>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </g>
  ),
  users: (
    <g {...stroke}>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M15.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </g>
  ),
  refresh: (
    <g {...stroke}>
      <path d="M20 11a8 8 0 0 0-14.3-4.6L4 8.5" />
      <path d="M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.6l1.7-2.1" />
      <path d="M20 20v-4.5h-4.5" />
    </g>
  ),
  alert: (
    <g {...stroke}>
      <path d="M10.3 4.3 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.5M12 17.2v.1" />
    </g>
  ),
  logout: (
    <g {...stroke}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />
    </g>
  ),
  grid: (
    <g {...stroke}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </g>
  ),
  audio: (
    <g {...stroke}>
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </g>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size,
  className,
  label,
}: {
  name: IconName;
  size?: number | string;
  className?: string;
  /** Only when the icon stands alone and means something. */
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size ?? '1em'}
      height={size ?? '1em'}
      className={`icon${className ? ` ${className}` : ''}`}
      {...(label
        ? { role: 'img', 'aria-label': label }
        : { 'aria-hidden': true, focusable: false })}
    >
      {ICONS[name]}
    </svg>
  );
}
