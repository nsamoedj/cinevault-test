// How to play a file on a device: direct play, remux or transcode (CLAUDE.md,
// phase 4). Direct play goes first; a remux keeps the video as it is and only
// repackages it (and converts the audio if needed); a transcode re-encodes the
// video to H.264 on the N100's GPU.

import {
  audioCodecString,
  checkDirectPlay,
  playedAudioTrack,
  type PlaybackCapabilities,
  videoCodecString,
} from './directPlay.js';
import type { AudioTrack, MediaFileDto } from './index.js';

export type Quality = 'original' | '1080p' | '720p';

export const QUALITIES: { id: Quality; height?: number }[] = [
  { id: 'original' },
  { id: '1080p', height: 1080 },
  { id: '720p', height: 720 },
];

/** Video bitrate (bit/s) for an H.264 transcode at this height. */
export function transcodeBitrate(height: number): number {
  if (height <= 480) return 2_000_000;
  if (height <= 720) return 4_000_000;
  if (height <= 1080) return 8_000_000;
  if (height <= 1440) return 12_000_000;
  return 20_000_000;
}

export type VideoPlan =
  { mode: 'copy' } | { mode: 'transcode'; codec: 'h264'; height: number; bitrate: number };

export type AudioPlan =
  { mode: 'copy' } | { mode: 'transcode'; codec: 'aac' | 'opus'; channels: 2; bitrate: number };

export type PlanReason =
  | { kind: 'video' | 'audio' | 'container'; codec: string }
  | { kind: 'quality'; height: number }
  | { kind: 'track' };

export type PlaybackPlan =
  | { mode: 'direct'; verdict: 'yes' | 'maybe' }
  | {
      mode: 'remux' | 'transcode';
      video: VideoPlan;
      /** Undefined for files without audio. */
      audio?: AudioPlan;
      /** Stream index of the audio track (AudioTrack.index). */
      audioTrack?: number;
      reasons: PlanReason[];
    }
  | { mode: 'unplayable'; reasons: PlanReason[] };

export interface PlanOptions {
  quality?: Quality;
  /** AudioTrack.index; defaults to the track the file marks as default. */
  audioTrack?: number;
  /** Direct play was tried and failed on this device: go through the transcoder. */
  noDirect?: boolean;
}

type PlannedFile = Pick<
  MediaFileDto,
  'container' | 'videoCodec' | 'width' | 'height' | 'bitDepth' | 'bitrate' | 'audioTracks'
>;

const H264 = 'avc1.640028';
/** Audio codecs browsers decode from fMP4 HLS segments. */
const COPYABLE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac']);

function canCopyAudio(track: AudioTrack, device: PlaybackCapabilities): boolean {
  const codec = audioCodecString(track.codec);
  return (
    COPYABLE_AUDIO.has(track.codec) &&
    codec !== undefined &&
    device.canPlay(`audio/mp4; codecs="${codec}"`)
  );
}

function audioTarget(device: PlaybackCapabilities): AudioPlan | undefined {
  if (device.canPlay('audio/mp4; codecs="mp4a.40.2"')) {
    return { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 192_000 };
  }
  if (device.canPlay('audio/mp4; codecs="opus"')) {
    return { mode: 'transcode', codec: 'opus', channels: 2, bitrate: 160_000 };
  }
  return undefined;
}

export function planPlayback(
  file: PlannedFile,
  device: PlaybackCapabilities,
  options: PlanOptions = {},
): PlaybackPlan {
  const quality = options.quality ?? 'original';
  const defaultTrack = playedAudioTrack(file);
  const track =
    options.audioTrack === undefined
      ? defaultTrack
      : (file.audioTracks.find((t) => t.index === options.audioTrack) ?? defaultTrack);
  // Browsers can't switch the audio track of a file they play directly.
  const otherTrack = track !== undefined && track !== defaultTrack;

  // A lower quality only means something when the file is bigger than that.
  const sourceHeight = file.height ?? 1080;
  const chosen = QUALITIES.find((q) => q.id === quality)?.height;
  // The device's limit counts as a quality the viewer chose.
  const wanted =
    device.maxHeight !== undefined && sourceHeight > device.maxHeight
      ? Math.min(chosen ?? device.maxHeight, device.maxHeight)
      : chosen;
  const height = Math.min(sourceHeight, wanted ?? sourceHeight, 2160);
  const lower =
    wanted !== undefined &&
    (sourceHeight > wanted || (file.bitrate ?? 0) > transcodeBitrate(wanted) * 1.5);

  const direct = checkDirectPlay(file, device);
  if (!lower && !otherTrack && !options.noDirect && direct.verdict !== 'no') {
    return { mode: 'direct', verdict: direct.verdict };
  }

  const reasons: PlanReason[] = direct.problems.map((p) => ({ kind: p.kind, codec: p.codec }));
  if (otherTrack) reasons.push({ kind: 'track' });
  if (options.noDirect && direct.verdict !== 'no') {
    reasons.push({ kind: 'container', codec: file.container ?? 'unknown' });
  }
  if (!device.hls) return { mode: 'unplayable', reasons };

  // Video: keep it when the device plays it and no lower quality was asked for.
  const videoCodec = videoCodecString(file);
  const copyVideo =
    !lower && videoCodec !== undefined && device.canPlay(`video/mp4; codecs="${videoCodec}"`);

  let video: VideoPlan;
  if (copyVideo) {
    video = { mode: 'copy' };
  } else if (device.canPlay(`video/mp4; codecs="${H264}"`)) {
    video = { mode: 'transcode', codec: 'h264', height, bitrate: transcodeBitrate(height) };
    if (lower) reasons.push({ kind: 'quality', height });
    else if (!reasons.some((r) => r.kind === 'video')) {
      reasons.push({ kind: 'video', codec: file.videoCodec ?? 'unknown' });
    }
  } else {
    if (!reasons.some((r) => r.kind === 'video')) {
      reasons.push({ kind: 'video', codec: file.videoCodec ?? 'unknown' });
    }
    return { mode: 'unplayable', reasons };
  }

  let audio: AudioPlan | undefined;
  if (track) {
    audio = canCopyAudio(track, device) ? { mode: 'copy' } : audioTarget(device);
    if (!audio) return { mode: 'unplayable', reasons };
  }

  return {
    mode: video.mode === 'copy' ? 'remux' : 'transcode',
    video,
    ...(audio && { audio }),
    ...(track && { audioTrack: track.index }),
    reasons,
  };
}

// --- Playback sessions (POST /api/playback) --------------------------------

export interface PlaybackRequest {
  fileId: string;
  /** Where to start, in seconds from the start of the file. */
  start: number;
  video: VideoPlan;
  audio?: AudioPlan;
  audioTrack?: number;
}

export type SessionStatus = 'queued' | 'running' | 'done' | 'failed';

export interface PlaybackSession {
  id: string;
  mode: 'remux' | 'transcode';
  status: SessionStatus;
  /**
   * Where the stream really starts, in seconds from the start of the file.
   * A remux can only start at a keyframe, which may be a little before the
   * requested position. Player time 0 is this point in the file.
   */
  start: number;
  /** Place in the queue (1 = next) while status is "queued". */
  queuePosition?: number;
  /** HLS playlist, relative to the server ("/api/playback/…/index.m3u8"). */
  playlistUrl: string;
  error?: string;
}

export interface TranscoderStatus {
  available: boolean;
  error?: string;
  hwaccel?: 'qsv' | 'none';
  /** HDR to SDR on the GPU (vpp_qsv tonemap) works. */
  tonemap?: boolean;
  maxTranscodes?: number;
  sessions?: { running: number; queued: number; transcodes: number };
}
