// Can this device play a file as is, without transcoding? (CLAUDE.md: direct
// play first.) The device answers per MIME type with codecs; the web app asks
// the <video> element, Expo will ask the native player.

import type { MediaFileDto } from './index.js';

export interface PlaybackCapabilities {
  /** True when the device can probably play `mime`, e.g. 'video/mp4; codecs="hvc1.2.4.L153.B0"'. */
  canPlay(mime: string): boolean;
  /** True when the device plays HLS with fMP4 segments (hls.js, Safari, native players). */
  hls?: boolean;
  /**
   * False when the device never plays Matroska files (Safari and every iOS
   * browser). Chromium does, without saying so; undefined means "try it".
   */
  matroska?: boolean;
  /** The tallest picture the device shows (a Chromecast without 4K: 1080); undefined for no limit. */
  maxHeight?: number;
}

export type DirectPlayVerdict = 'yes' | 'maybe' | 'no';

export interface DirectPlayProblem {
  kind: 'video' | 'audio' | 'container';
  codec: string;
}

export interface DirectPlayResult {
  verdict: DirectPlayVerdict;
  problems: DirectPlayProblem[];
  /** MIME type with codecs that was checked, for diagnostics. */
  mime?: string;
}

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

/** RFC 6381 codec string for the video track, or undefined when browsers don't do it at all. */
export function videoCodecString(
  file: Pick<MediaFileDto, 'videoCodec' | 'height' | 'bitDepth'> &
    Partial<Pick<MediaFileDto, 'hdrFormat' | 'dvProfile'>>,
): string | undefined {
  const uhd = (file.height ?? 0) > 1100;
  const tenBit = (file.bitDepth ?? 8) >= 10;
  // Dolby Vision profile 5 has no HDR10 base: only a DV decoder shows it right
  // (Safari wants "dvh1"). Profile 8 plays as HDR10/HLG everywhere, so it stays hvc1.
  if (file.videoCodec === 'hevc' && file.hdrFormat === 'DV' && file.dvProfile === 5) {
    return `dvh1.05.${uhd ? '06' : '03'}`;
  }
  switch (file.videoCodec) {
    case 'h264':
      // High profile, level 5.1 for 4K, 4.0 otherwise.
      return uhd ? 'avc1.640033' : 'avc1.640028';
    case 'hevc':
      // Main10 or Main, level 5.1 (4K) or 4.1.
      return `${tenBit ? 'hvc1.2.4' : 'hvc1.1.6'}.${uhd ? 'L153' : 'L123'}.B0`;
    case 'av1':
      return `av01.0.${uhd ? '12M' : '08M'}.${tenBit ? '10' : '08'}`;
    case 'vp9':
      return tenBit ? 'vp09.02.51.10' : 'vp09.00.41.08';
    case 'vp8':
      return 'vp8';
    default:
      return undefined;
  }
}

const AUDIO_CODECS: Record<string, string> = {
  aac: 'mp4a.40.2',
  mp3: 'mp4a.6b',
  opus: 'opus',
  vorbis: 'vorbis',
  flac: 'flac',
  ac3: 'ac-3',
  eac3: 'ec-3',
  dts: 'dtsc',
  truehd: 'mlpa',
};

/** RFC 6381 codec string for an audio codec, or undefined when browsers don't do it at all. */
export function audioCodecString(codec: string): string | undefined {
  return AUDIO_CODECS[codec];
}

/** The track a browser plays: the default one, else the first. */
export function playedAudioTrack(file: Pick<MediaFileDto, 'audioTracks'>) {
  return file.audioTracks.find((t) => t.default) ?? file.audioTracks[0];
}

export function checkDirectPlay(
  file: Pick<MediaFileDto, 'container' | 'videoCodec' | 'height' | 'bitDepth' | 'audioTracks'>,
  device: PlaybackCapabilities,
): DirectPlayResult {
  const container = file.container ?? 'unknown';
  const video = videoCodecString(file);
  const audioTrack = playedAudioTrack(file);
  const audio = audioTrack ? AUDIO_CODECS[audioTrack.codec] : undefined;
  const containerMime = CONTAINER_MIME[container];

  // 1. Formats no browser plays.
  const problems: DirectPlayProblem[] = [];
  if (!video) problems.push({ kind: 'video', codec: file.videoCodec ?? 'unknown' });
  if (audioTrack && !audio) problems.push({ kind: 'audio', codec: audioTrack.codec });
  if (!containerMime || (container === 'mkv' && device.matroska === false)) {
    problems.push({ kind: 'container', codec: container });
  }
  if (problems.length > 0 || !video || !containerMime) return { verdict: 'no', problems };

  // 2. The device vouches for the exact combination.
  const mime = `${containerMime}; codecs="${[video, audio].filter(Boolean).join(', ')}"`;
  if (device.canPlay(mime)) return { verdict: 'yes', problems: [], mime };

  // 3. Each codec on its own. Browsers rarely vouch for Matroska although
  // Chromium plays it, so supported codecs in MKV mean "try it".
  const supports = (kind: 'video' | 'audio', codec: string) =>
    device.canPlay(`${kind}/mp4; codecs="${codec}"`) ||
    device.canPlay(`${kind}/webm; codecs="${codec}"`);
  if (!supports('video', video))
    problems.push({ kind: 'video', codec: file.videoCodec ?? 'unknown' });
  if (audio && audioTrack && !supports('audio', audio)) {
    problems.push({ kind: 'audio', codec: audioTrack.codec });
  }
  if (problems.length > 0) return { verdict: 'no', problems, mime };
  return { verdict: 'maybe', problems: [], mime };
}
