// Theme music on a title's page: the sound of its intro or end credits (made
// by the server), quietly, with a fade in and out, once. Off, soft, normal or
// loud is a choice per device (Profiel); on a TV it is on, on a phone off until
// chosen. On the TV it also plays while browsing: the theme of the poster that
// has the focus, once the focus rests there.
//
// An expo-video player without a view plays the MP3: ExoPlayer plays sound by
// itself, so no extra native module (and no other APK) is needed for it. One
// player for the whole app: going from a poster to the title's page keeps the
// same song going instead of starting it again. Leaving a title's page stops
// it at once, and so does leaving the app: Android pauses the app's timers in
// the background, so a fade there would never end (the song played on until
// the app was closed).

import { useQuery } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { keys } from './keys';
import { THEME_VOLUME, useThemeMusicSetting } from './preferences';
import { useSession } from './session';

const FADE_IN_MS = 1500;
const FADE_OUT_MS = 350;
const STEP_MS = 50;
/** Asks again while the server makes it (about half a minute). */
const POLL_MS = 5000;
const POLLS = 6;
/** Browsing lets go to open the title: this long for its page to take the same song over. */
const HANDOFF_MS = 2500;
/** Browsing: the focus rests this long on a poster before its theme starts. */
const BROWSE_REST_MS = 800;

interface Playing {
  url: string;
  player: VideoPlayer;
  playing: boolean;
  ended: boolean;
  fade?: ReturnType<typeof setInterval>;
  handoff?: ReturnType<typeof setTimeout>;
  listeners: { remove(): void }[];
}

let current: Playing | undefined;
/**
 * A song that was stopped (the title's page was left, the app went to the
 * background): browsing doesn't start it again while the focus stays on that
 * poster. Opening the title's page again plays it.
 */
let dismissed: string | undefined;
const watchers = new Set<() => void>();
const notify = () => {
  for (const watcher of watchers) watcher();
};

function ramp(song: Playing, target: number, ms: number, done?: () => void) {
  clearInterval(song.fade);
  let from = 0;
  try {
    from = song.player.volume;
  } catch {
    // Released already.
  }
  const started = Date.now();
  song.fade = setInterval(() => {
    const share = Math.min(1, (Date.now() - started) / ms);
    try {
      song.player.volume = from + (target - from) * share;
    } catch {
      // Released already.
    }
    if (share >= 1) {
      clearInterval(song.fade);
      done?.();
    }
  }, STEP_MS);
}

/** Songs fading out (no longer `current`): stopped at once when the app leaves the front. */
const fading = new Set<Playing>();

function fadeAway(song: Playing) {
  clearTimeout(song.handoff);
  for (const listener of song.listeners) listener.remove();
  song.playing = false;
  if (current === song) current = undefined;
  fading.add(song);
  notify();
  ramp(song, 0, FADE_OUT_MS, () => {
    fading.delete(song);
    try {
      song.player.pause();
      song.player.release();
    } catch {
      // Released already.
    }
  });
}

/** Stops at once, without a fade (no timers in the background). */
function stopAtOnce(song: Playing) {
  fading.delete(song);
  clearTimeout(song.handoff);
  clearInterval(song.fade);
  for (const listener of song.listeners) listener.remove();
  song.playing = false;
  if (current === song) current = undefined;
  try {
    song.player.pause();
    song.player.release();
  } catch {
    // Released already.
  }
  notify();
}

// Another app in front (or the screen off): silence now.
AppState.addEventListener('change', (state) => {
  if (state === 'active') return;
  for (const song of [...fading]) stopAtOnce(song);
  if (!current) return;
  dismissed = current.url;
  stopAtOnce(current);
});

/** Plays `url`, or keeps it going when it plays already (a song heard to the end stays quiet). */
function claim(
  url: string,
  headers: Record<string, string> | undefined,
  volume: number,
  browsing: boolean,
) {
  if (browsing && url === dismissed) return;
  dismissed = undefined;
  if (current?.url === url) {
    clearTimeout(current.handoff);
    current.handoff = undefined;
    if (!current.ended) ramp(current, volume, FADE_IN_MS);
    return;
  }
  if (current) fadeAway(current);
  const player = createVideoPlayer({ uri: url, ...(headers && { headers }) });
  // Other sound (music, a podcast) goes quiet for a moment, and comes back.
  player.audioMixingMode = 'duckOthers';
  player.loop = false;
  player.volume = 0;
  const song: Playing = { url, player, playing: false, ended: false, listeners: [] };
  song.listeners.push(
    player.addListener('playingChange', ({ isPlaying }) => {
      song.playing = isPlaying;
      notify();
    }),
    player.addListener('playToEnd', () => {
      song.ended = true;
      song.playing = false;
      notify();
    }),
  );
  current = song;
  player.play();
  ramp(song, volume, FADE_IN_MS);
}

/**
 * The screen that played it lets go:
 * - `handoff`: browsing, on the way to the title's page; the song goes on a
 *   moment for that page to take it over;
 * - `fade`: browsing, the focus moved on; a short fade;
 * - `stop`: the title's page was left; a short fade, and the song doesn't
 *   start again for this title by itself (back on the poster it came from).
 */
function letGo(url: string, how: 'handoff' | 'fade' | 'stop') {
  const song = current;
  if (song?.url !== url) return;
  clearTimeout(song.handoff);
  if (how === 'handoff') {
    song.handoff = setTimeout(() => fadeAway(song), HANDOFF_MS);
    return;
  }
  if (how === 'stop') dismissed = url;
  fadeAway(song);
}

/** Stops the theme music at once (the player starts, or the viewer stops it). */
export function stopThemeMusic() {
  if (current) fadeAway(current);
}

const subscribe = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
const playingUrl = () => (current?.playing ? current.url : undefined);

function useThemePlayback(
  itemId: string,
  options: { enabled: boolean; ready?: boolean },
): { playing: boolean; stop: () => void } {
  const { api, authHeaders } = useSession();
  const [level] = useThemeMusicSetting();
  const [stoppedFor, setStoppedFor] = useState<string>();
  const [focused, setFocused] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const on = level !== 'off';
  const ready = Boolean(options.ready);

  const theme = useQuery({
    // Browsing asks only for themes made already: its own key, so a title's
    // page still asks the server to make one.
    queryKey: ready ? [...keys.theme(itemId), 'ready'] : keys.theme(itemId),
    queryFn: () => api.theme(itemId, { ready }),
    enabled: options.enabled && on && Boolean(itemId),
    staleTime: 60_000,
    refetchInterval: (query) =>
      !ready && query.state.data?.pending && query.state.dataUpdateCount < POLLS ? POLL_MS : false,
  });
  const url = theme.data?.url ? api.resolveUrl(theme.data.url) : undefined;

  // The screen is in front: read when letting go (on the way to another screen or not).
  const inFront = useRef(true);
  useFocusEffect(
    useCallback(() => {
      inFront.current = true;
      setFocused(true);
      return () => {
        inFront.current = false;
        setFocused(false);
      };
    }, []),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => subscription.remove();
  }, []);

  const active = options.enabled && on && focused && foreground && stoppedFor !== itemId;
  const volume = level === 'off' ? 0 : THEME_VOLUME[level];

  // Read when the song starts; a new value doesn't restart it.
  const start = useRef({ authHeaders, volume });
  useEffect(() => {
    start.current = { authHeaders, volume };
  });
  useEffect(() => {
    if (!url || !active) return;
    claim(url, start.current.authHeaders, start.current.volume, ready);
    return () => letGo(url, !ready ? 'stop' : inFront.current ? 'fade' : 'handoff');
  }, [url, active, ready]);
  // Another volume chosen while it plays.
  useEffect(() => {
    if (url && current?.url === url && !current.ended) ramp(current, volume, 300);
  }, [url, volume]);

  const now = useSyncExternalStore(subscribe, playingUrl);
  const stop = useCallback(() => {
    setStoppedFor(itemId);
    if (url && current?.url === url) fadeAway(current);
  }, [itemId, url]);
  return { playing: Boolean(url) && now === url, stop };
}

/**
 * Plays a title's theme while its page is in front (not the player, not
 * another app). `stop` ends it for this visit.
 */
export function useThemeMusic(
  itemId: string,
  /** The title is known (films and shows alike). */
  enabled: boolean,
): { playing: boolean; stop: () => void } {
  return useThemePlayback(itemId, { enabled });
}

/**
 * TV, browsing: the theme of the title with the focus, once the focus rests
 * on it. When the focus moves on, the song fades at once (not after the
 * rest), and the next poster's starts when the focus rests there. Only
 * themes the server has already.
 */
export function useBrowseThemeMusic(itemId: string | undefined): void {
  const [resting, setResting] = useState<string>();
  useEffect(() => {
    // The focus moved: a song stopped on the poster it was on may play again there.
    dismissed = undefined;
    if (!itemId) return;
    const timer = setTimeout(() => setResting(itemId), BROWSE_REST_MS);
    return () => clearTimeout(timer);
  }, [itemId]);
  // Only while the focus is still on the poster it rested on.
  const playing = resting !== undefined && resting === itemId ? resting : undefined;
  useThemePlayback(playing ?? '', { enabled: Boolean(playing), ready: true });
}
