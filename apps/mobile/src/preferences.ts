// Settings of this phone: quality, picture fit, the subtitle language,
// skipping intros by itself, theme music, and audio codecs whose decoder failed, in SecureStore (small values, no extra
// storage module needed).

import type { CastQuality, Quality } from '@cinevault/shared';
import type { FitMode } from './player/fit';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

const QUALITY_KEY = 'cinevault.quality';
const SUBTITLES_KEY = 'cinevault.subtitles';
const FAILED_AUDIO_KEY = 'cinevault.failedAudio';
const FIT_KEY = 'cinevault.fit';
const CAST_KEY = 'cinevault.castQuality';
const AUTO_SKIP_KEY = 'cinevault.autoSkipIntro';
const THEME_KEY = 'cinevault.themeMusic';

let quality: Quality = 'original';
let subtitles: string | undefined;
let failedAudio: string[] = [];
let fit: FitMode = 'auto';
let castQuality: CastQuality = 'auto';
let autoSkip = false;
/** Theme music on a show's page: on a TV as in Plex, on a phone only when chosen. */
export type ThemeLevel = 'off' | 'soft' | 'normal' | 'loud';
export const THEME_VOLUME: Record<Exclude<ThemeLevel, 'off'>, number> = {
  soft: 0.2,
  normal: 0.35,
  loud: 0.6,
};
let themeLevel: ThemeLevel = Platform.isTV ? 'normal' : 'off';
const listeners = new Set<() => void>();

// Read once at start; the values are small and rarely change.
void Promise.all([
  SecureStore.getItemAsync(QUALITY_KEY),
  SecureStore.getItemAsync(SUBTITLES_KEY),
  SecureStore.getItemAsync(FAILED_AUDIO_KEY),
  SecureStore.getItemAsync(FIT_KEY),
  SecureStore.getItemAsync(CAST_KEY),
  SecureStore.getItemAsync(AUTO_SKIP_KEY),
  SecureStore.getItemAsync(THEME_KEY),
]).then(
  ([
    storedQuality,
    storedSubtitles,
    storedFailedAudio,
    storedFit,
    storedCast,
    storedSkip,
    storedTheme,
  ]) => {
    if (storedQuality === '1080p' || storedQuality === '720p') quality = storedQuality;
    subtitles = storedSubtitles ?? undefined;
    failedAudio = storedFailedAudio?.split(',').filter(Boolean) ?? [];
    if (storedFit === 'fit' || storedFit === 'fill') fit = storedFit;
    if (storedCast === '4k' || storedCast === '1080p') castQuality = storedCast;
    autoSkip = storedSkip === 'on';
    if (
      storedTheme === 'off' ||
      storedTheme === 'soft' ||
      storedTheme === 'normal' ||
      storedTheme === 'loud'
    ) {
      themeLevel = storedTheme;
    }
    for (const listener of listeners) listener();
  },
);

export function savedQuality(): Quality {
  return quality;
}

export function saveQuality(next: Quality): void {
  quality = next;
  void SecureStore.setItemAsync(QUALITY_KEY, next);
  for (const listener of listeners) listener();
}

export function useQualitySetting(): [Quality, (next: Quality) => void] {
  const [value, setValue] = useState(quality);
  useEffect(() => {
    const listener = () => setValue(quality);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const set = useCallback((next: Quality) => saveQuality(next), []);
  return [value, set];
}

/** "off", a language ("nld"), or undefined when never chosen on this phone. */
export function savedSubtitlePreference(): string | undefined {
  return subtitles;
}

export function saveSubtitlePreference(value: string): void {
  subtitles = value;
  void SecureStore.setItemAsync(SUBTITLES_KEY, value);
}

/** Audio codecs ("ec-3") whose decoder failed on this phone: the server converts them. */
export function failedAudioCodecs(): string[] {
  return failedAudio;
}

export function saveFailedAudioCodec(codec: string): void {
  if (failedAudio.includes(codec)) return;
  failedAudio = [...failedAudio, codec];
  void SecureStore.setItemAsync(FAILED_AUDIO_KEY, failedAudio.join(','));
}

/** How the picture fills the screen ("Beeldformaat"). */
export function savedFit(): FitMode {
  return fit;
}

export function saveFit(next: FitMode): void {
  fit = next;
  void SecureStore.setItemAsync(FIT_KEY, next);
}

/** What the Chromecast plays: by its model ("auto"), or set by the viewer. */
export function savedCastQuality(): CastQuality {
  return castQuality;
}

export function useCastQualitySetting(): [CastQuality, (next: CastQuality) => void] {
  const [value, setValue] = useState(castQuality);
  useEffect(() => {
    const listener = () => setValue(castQuality);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const set = useCallback((next: CastQuality) => {
    castQuality = next;
    void SecureStore.setItemAsync(CAST_KEY, next);
    for (const listener of listeners) listener();
  }, []);
  return [value, set];
}

/**
 * "Intro automatisch overslaan" was per device until 2026-11-13; now it is
 * per profile (SkipSettings). True once when this device had it on.
 */
export function forgetDeviceAutoSkip(): boolean {
  const on = autoSkip;
  if (on) {
    autoSkip = false;
    void SecureStore.deleteItemAsync(AUTO_SKIP_KEY);
  }
  return on;
}

/** "Themamuziek" on this device: off, or how loud. */
export function useThemeMusicSetting(): [ThemeLevel, (next: ThemeLevel) => void] {
  const [value, setValue] = useState(themeLevel);
  useEffect(() => {
    const listener = () => setValue(themeLevel);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const set = useCallback((next: ThemeLevel) => {
    themeLevel = next;
    void SecureStore.setItemAsync(THEME_KEY, next);
    for (const listener of listeners) listener();
  }, []);
  return [value, set];
}
