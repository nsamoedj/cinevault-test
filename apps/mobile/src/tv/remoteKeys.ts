// The TV remote's buttons, as React Native on Android reports them
// ("onHWKeyEvent", ReactAndroidHWInputDeviceHelper). No React Native here, so
// the tests can load it; the hook is in remote.ts.

export type RemoteKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'select'
  | 'playPause'
  | 'play'
  | 'pause'
  | 'rewind'
  | 'fastForward'
  | 'next'
  | 'previous'
  | 'stop'
  | 'menu'
  | 'info';

const KEYS = new Set<string>([
  'up',
  'down',
  'left',
  'right',
  'select',
  'playPause',
  'play',
  'pause',
  'rewind',
  'fastForward',
  'next',
  'previous',
  'stop',
  'menu',
  'info',
]);

/** Android's KeyEvent.ACTION_DOWN; a held button repeats it. */
const ACTION_DOWN = 0;

export interface HWKeyEvent {
  eventType?: string;
  eventKeyAction?: number;
  tag?: number;
}

/** The button that went down, or undefined (a release, or a focus change). */
export function remoteKey(event: HWKeyEvent): RemoteKey | undefined {
  if (event.eventKeyAction !== ACTION_DOWN || !event.eventType) return undefined;
  return KEYS.has(event.eventType) ? (event.eventType as RemoteKey) : undefined;
}

/**
 * Seconds per step while a seek button is held or pressed quickly: 10 s at
 * first, then faster, so a two-hour film can be crossed.
 */
export function seekStep(repeats: number): number {
  if (repeats >= 20) return 120;
  if (repeats >= 10) return 60;
  if (repeats >= 4) return 30;
  return 10;
}
