import {
  checkDirectPlay,
  type DirectPlayProblem,
  type DirectPlayResult,
  type MediaFileDto,
  type PlaybackCapabilities,
  type PlaybackPlan,
  type PlanOptions,
  planPlayback,
  type PlanReason,
  type Quality,
} from '@cinevault/shared';
import { codecLabel } from './format.js';

// What a browser can play doesn't change during a session.
const cache = new Map<string, boolean>();

/** For tests that change what the fake browser supports. */
export function resetPlaybackCache(): void {
  cache.clear();
}

/**
 * Safari, and every browser on iOS (they all use WebKit). They play no
 * Matroska, and play HLS themselves with Apple's own player.
 */
export function isAppleWebKit(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.vendor.startsWith('Apple');
  } catch {
    return false;
  }
}

/**
 * Play HLS with the browser's own player instead of hls.js. Only in Safari:
 * Apple's player handles 4K HEVC, HDR, Dolby Vision and Dolby audio better than
 * Media Source Extensions do there (hls.js), and needs less memory.
 */
export function nativeHls(video: HTMLVideoElement): boolean {
  return isAppleWebKit() && video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function supportsHls(): boolean {
  try {
    // hls.js needs Media Source Extensions; Safari on iOS has ManagedMediaSource or plays HLS itself.
    return (
      typeof MediaSource !== 'undefined' ||
      'ManagedMediaSource' in globalThis ||
      document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== ''
    );
  } catch {
    return false;
  }
}

/** Asks this browser's <video> element (and Media Source Extensions). */
export const browserDevice: PlaybackCapabilities = {
  get hls() {
    return supportsHls();
  },
  get matroska() {
    return !isAppleWebKit();
  },
  canPlay(mime) {
    const known = cache.get(mime);
    if (known !== undefined) return known;
    let result: boolean;
    try {
      // With a codecs parameter, "probably" means supported; "maybe" means unknown.
      // Media Source Extensions only count for MP4: what hls.js plays.
      result =
        document.createElement('video').canPlayType(mime) === 'probably' ||
        (/^(video|audio)\/mp4;/.test(mime) &&
          typeof MediaSource !== 'undefined' &&
          MediaSource.isTypeSupported(mime));
    } catch {
      result = false;
    }
    cache.set(mime, result);
    return result;
  },
};

export function directPlay(
  file: MediaFileDto,
  device: PlaybackCapabilities = browserDevice,
): DirectPlayResult {
  return checkDirectPlay(file, device);
}

export function describeProblem(problem: DirectPlayProblem): string {
  const name = codecLabel(problem.codec);
  switch (problem.kind) {
    case 'video':
      return `videocodec ${name}`;
    case 'audio':
      return `audio ${name}`;
    case 'container':
      return `bestandsformaat ${name}`;
  }
}

export function describeProblems(problems: DirectPlayProblem[]): string {
  return problems.map(describeProblem).join(' en ');
}

/** "audio E-AC3 wordt niet ondersteund" / "videocodec HEVC en audio E-AC3 worden niet ondersteund" */
export function unsupportedSentence(problems: DirectPlayProblem[]): string {
  return `${describeProblems(problems)} ${problems.length > 1 ? 'worden' : 'wordt'} niet ondersteund`;
}

export function plan(
  file: MediaFileDto,
  options: PlanOptions = {},
  device: PlaybackCapabilities = browserDevice,
): PlaybackPlan {
  return planPlayback(file, device, options);
}

export const qualityLabel: Record<Quality, string> = {
  original: 'Origineel',
  '1080p': '1080p',
  '720p': '720p',
};

function reasonLabel(reason: PlanReason, plan: PlaybackPlan): string {
  const audioTarget =
    plan.mode !== 'direct' && plan.mode !== 'unplayable' && plan.audio?.mode === 'transcode'
      ? plan.audio.codec === 'aac'
        ? 'AAC'
        : 'Opus'
      : undefined;
  switch (reason.kind) {
    case 'video':
      return `videocodec ${codecLabel(reason.codec)}`;
    case 'audio':
      return `audio ${codecLabel(reason.codec)}${audioTarget ? ` wordt ${audioTarget}` : ''}`;
    case 'container':
      return `bestandsformaat ${codecLabel(reason.codec)}`;
    case 'quality':
      return `kwaliteit ${reason.height}p`;
    case 'track':
      return 'ander audiospoor';
  }
}

/** One line for the player and the play button: what happens with this file. */
export function planSummary(plan: PlaybackPlan): string {
  switch (plan.mode) {
    case 'direct':
      return 'Direct afspelen, zoals het bestand is';
    case 'remux':
      return `Beeld origineel, omgepakt door de server (${plan.reasons.map((r) => reasonLabel(r, plan)).join(', ')})`;
    case 'transcode': {
      const video = plan.video.mode === 'transcode' ? plan.video : undefined;
      const target = video ? `H.264 ${video.height}p` : 'H.264';
      return `Omgezet naar ${target} door de server (${plan.reasons.map((r) => reasonLabel(r, plan)).join(', ')})`;
    }
    case 'unplayable':
      return `Niet af te spelen in deze browser: ${plan.reasons.map((r) => reasonLabel(r, plan)).join(', ')}`;
  }
}

const QUALITY_KEY = 'cinevault.quality';

/** The quality last chosen on this device. */
export function savedQuality(): Quality {
  try {
    const value = localStorage.getItem(QUALITY_KEY);
    if (value === '1080p' || value === '720p') return value;
  } catch {
    // Storage blocked: use the default.
  }
  return 'original';
}

export function saveQuality(quality: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // Not remembered; fine.
  }
}

/** Starts playback; browsers refuse autoplay with sound until the first click, which is fine. */
export function playQuietly(video: HTMLVideoElement): void {
  try {
    void video.play()?.catch(() => {});
  } catch {
    // Not allowed or not supported: the play button is there.
  }
}

const AUTO_SKIP_KEY = 'cinevault.autoSkipIntro';

/**
 * "Intro automatisch overslaan" was per device until 2026-11-13; now it is
 * per profile (SkipSettings). True once when this device had it on.
 */
export function forgetDeviceAutoSkip(): boolean {
  try {
    const on = localStorage.getItem(AUTO_SKIP_KEY) === 'on';
    localStorage.removeItem(AUTO_SKIP_KEY);
    return on;
  } catch {
    return false;
  }
}
