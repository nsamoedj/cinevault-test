// Theme music on a title's detail page: the sound of its intro or end
// credits, quietly, with a fade in and out. On or off and how loud is a choice per device (Profiel).
// Browsers play sound only after a click or tap on the page; arriving from
// another page counts, a page opened from a link starts at the first click.

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, keys } from './api.js';

const SETTINGS_KEY = 'cinevault.themeMusic';
const FADE_IN_MS = 1500;
const FADE_OUT_MS = 700;
/** Asks again while the server makes it (about half a minute). */
const POLL_MS = 5000;
const POLLS = 6;

export interface ThemeMusicSettings {
  on: boolean;
  /** 0-1, of the device's volume. */
  volume: number;
}

export const DEFAULT_THEME_MUSIC: ThemeMusicSettings = { on: true, volume: 0.3 };

export function savedThemeMusic(): ThemeMusicSettings {
  try {
    const value = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? 'null',
    ) as Partial<ThemeMusicSettings> | null;
    return {
      on: typeof value?.on === 'boolean' ? value.on : DEFAULT_THEME_MUSIC.on,
      volume:
        typeof value?.volume === 'number' && value.volume >= 0 && value.volume <= 1
          ? value.volume
          : DEFAULT_THEME_MUSIC.volume,
    };
  } catch {
    return DEFAULT_THEME_MUSIC;
  }
}

export function saveThemeMusic(settings: ThemeMusicSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: only for this time.
  }
}

interface Fader {
  /** Goes to `target` (0-1) in `ms`, then calls `done`. */
  ramp(target: number, ms: number, done?: () => void): void;
  /** Before play(): Web Audio needs its context running. */
  resume(): void;
  close(): void;
}

/**
 * Safari on iPhone and iPad ignores audio.volume (always the device's volume);
 * there the sound goes through a Web Audio gain instead.
 */
function fixedVolume(): boolean {
  const probe = new Audio();
  probe.volume = 0.5;
  return probe.volume !== 0.5;
}

function createFader(audio: HTMLAudioElement): Fader {
  if (fixedVolume() && typeof AudioContext !== 'undefined') {
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.value = 0;
    context.createMediaElementSource(audio).connect(gain).connect(context.destination);
    return {
      ramp(target, ms, done) {
        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(target, now + ms / 1000);
        if (done) setTimeout(done, ms);
      },
      resume: () => void context.resume().catch(() => {}),
      close: () => void context.close().catch(() => {}),
    };
  }
  audio.volume = 0;
  let timer: number | undefined;
  return {
    ramp(target, ms, done) {
      window.clearInterval(timer);
      const from = audio.volume;
      const started = performance.now();
      timer = window.setInterval(() => {
        const share = Math.min(1, (performance.now() - started) / ms);
        audio.volume = Math.max(0, Math.min(1, from + (target - from) * share));
        if (share >= 1) {
          window.clearInterval(timer);
          done?.();
        }
      }, 40);
    },
    resume() {},
    close: () => window.clearInterval(timer),
  };
}

/**
 * Plays a title's theme while `active` (the detail page is open, no trailer),
 * once, with the device's settings. `stop` ends it for this visit.
 */
export function useThemeMusic(
  itemId: string,
  /** `enabled`: the title is known (films and shows alike). */
  options: { enabled: boolean; active: boolean },
): { playing: boolean; stop: () => void } {
  const [settings] = useState(savedThemeMusic);
  // Stopped for this show; another show plays its own theme.
  const [stoppedFor, setStoppedFor] = useState<string>();
  const stopped = stoppedFor === itemId;
  const [playing, setPlaying] = useState(false);
  const fadeOut = useRef<() => void>(undefined);
  const theme = useQuery({
    queryKey: keys.theme(itemId),
    queryFn: () => api.theme(itemId),
    enabled: options.enabled && settings.on,
    staleTime: 60_000,
    refetchInterval: (query) =>
      query.state.data?.pending && query.state.dataUpdateCount < POLLS ? POLL_MS : false,
  });
  const url = theme.data?.url;
  const active = options.active && settings.on && !stopped;

  useEffect(() => {
    if (!url || !active) return;
    const audio = new Audio(url);
    audio.preload = 'auto';
    const fader = createFader(audio);
    let done = false;
    const gestures = ['pointerdown', 'keydown'] as const;
    const removeGestures = () => {
      for (const name of gestures) document.removeEventListener(name, onGesture, true);
    };
    const start = () => {
      if (done) return;
      fader.resume();
      audio.play().then(
        () => {
          // Left (or stopped) while play() was pending: no sound under the next page.
          if (done) {
            audio.pause();
            fader.close();
            return;
          }
          setPlaying(true);
          fader.ramp(settings.volume, FADE_IN_MS);
        },
        (error: unknown) => {
          // No click on the page yet: start at the first one.
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            for (const name of gestures) document.addEventListener(name, onGesture, true);
          }
        },
      );
    };
    function onGesture() {
      removeGestures();
      start();
    }
    const ended = () => setPlaying(false);
    audio.addEventListener('ended', ended);
    // Away from the tab: quiet; back: on again, if it was playing.
    const visibility = () => {
      if (document.hidden) audio.pause();
      else if (!audio.ended && audio.currentTime > 0) void audio.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', visibility);
    start();
    const finish = () => {
      if (done) return;
      done = true;
      removeGestures();
      document.removeEventListener('visibilitychange', visibility);
      audio.removeEventListener('ended', ended);
      setPlaying(false);
      fader.ramp(0, FADE_OUT_MS, () => {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        fader.close();
      });
    };
    fadeOut.current = finish;
    return finish;
  }, [url, active, settings.volume]);

  const stop = useCallback(() => {
    setStoppedFor(itemId);
    fadeOut.current?.();
  }, [itemId]);
  return { playing, stop };
}
