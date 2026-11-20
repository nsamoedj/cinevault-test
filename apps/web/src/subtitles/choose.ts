// Which subtitle to show when a player opens.

import { chooseSubtitle as chooseShared, type SubtitleOption } from '@cinevault/shared';

const PREFERENCE_KEY = 'cinevault.subtitles';

/** "off", a language ("nld"), or undefined when never chosen on this device. */
export function savedPreference(): string | undefined {
  try {
    return localStorage.getItem(PREFERENCE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function savePreference(value: string): void {
  try {
    localStorage.setItem(PREFERENCE_KEY, value);
  } catch {
    // Not remembered; fine.
  }
}

/** The subtitle to start with on this device, or as chosen for the show (see packages/shared). */
export function chooseSubtitle(
  options: SubtitleOption[],
  audioLanguage: string | undefined,
  preference: string | undefined = savedPreference(),
  forShow?: string,
): SubtitleOption | undefined {
  return chooseShared(options, audioLanguage, preference, forShow);
}
