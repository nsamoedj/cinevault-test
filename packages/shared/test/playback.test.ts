import { describe, expect, it } from 'vitest';
import type { PlaybackCapabilities } from '../src/directPlay.js';
import type { AudioTrack, MediaFileDto } from '../src/index.js';
import { planPlayback, transcodeBitrate } from '../src/playback.js';

/** A browser that plays MP4/WebM with the given codecs and HLS when `hls` is set. */
function device(codecs: string[], hls = true): PlaybackCapabilities {
  return {
    hls,
    canPlay(mime) {
      const match = /^(?:video|audio)\/(mp4|webm); codecs="([^"]+)"$/.exec(mime);
      if (!match) return false;
      return (match[2] ?? '').split(', ').every((c) => codecs.includes(c));
    },
  };
}

// Chrome on Windows with hardware HEVC, without Dolby audio.
const chrome = device(['avc1.640028', 'avc1.640033', 'hvc1.2.4.L153.B0', 'mp4a.40.2', 'opus']);
// Firefox: no HEVC.
const firefox = device(['avc1.640028', 'mp4a.40.2', 'opus', 'vp09.00.41.08']);
// Safari on a Mac with Apple silicon: HEVC, HDR and Dolby audio, but no Matroska.
const safari: PlaybackCapabilities = {
  ...device(['avc1.640028', 'avc1.640033', 'hvc1.2.4.L153.B0', 'mp4a.40.2', 'ec-3', 'ac-3']),
  matroska: false,
};
// Open-source Chromium (the test browser): no H.264 or AAC.
const chromium = device(['vp09.00.41.08', 'opus']);

const track = (index: number, codec: string, isDefault = false): AudioTrack => ({
  index,
  codec,
  default: isDefault,
});

const uhd: Pick<
  MediaFileDto,
  'container' | 'videoCodec' | 'width' | 'height' | 'bitDepth' | 'bitrate' | 'audioTracks'
> = {
  container: 'mkv',
  videoCodec: 'hevc',
  width: 3840,
  height: 2160,
  bitDepth: 10,
  bitrate: 60_000_000,
  audioTracks: [track(1, 'aac', true)],
};

describe('planPlayback', () => {
  it('plays directly when the device can', () => {
    expect(planPlayback(uhd, chrome)).toEqual({ mode: 'direct', verdict: 'maybe' });
  });

  it('remuxes when only the audio is the problem, keeping 4K HEVC', () => {
    const file = { ...uhd, audioTracks: [track(1, 'eac3', true)] };
    expect(planPlayback(file, chrome)).toEqual({
      mode: 'remux',
      video: { mode: 'copy' },
      audio: { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 192_000 },
      audioTrack: 1,
      reasons: [{ kind: 'audio', codec: 'eac3' }],
    });
  });

  it('transcodes video the device cannot play, at the source height', () => {
    expect(planPlayback(uhd, firefox)).toMatchObject({
      mode: 'transcode',
      video: { mode: 'transcode', codec: 'h264', height: 2160, bitrate: 20_000_000 },
      audio: { mode: 'copy' },
      reasons: [{ kind: 'video', codec: 'hevc' }],
    });
  });

  it('transcodes to a lower quality on request', () => {
    expect(planPlayback(uhd, chrome, { quality: '1080p' })).toMatchObject({
      mode: 'transcode',
      video: { mode: 'transcode', height: 1080, bitrate: 8_000_000 },
      reasons: [{ kind: 'quality', height: 1080 }],
    });
    // A 720p request for a small file changes nothing: direct play stays.
    const small = {
      ...uhd,
      videoCodec: 'h264',
      height: 720,
      width: 1280,
      bitDepth: 8,
      bitrate: 3e6,
    };
    expect(planPlayback(small, chrome, { quality: '720p' }).mode).toBe('direct');
    // A heavy 1080p file at "1080p" gets a lighter transcode.
    const heavy = { ...small, height: 1080, width: 1920, bitrate: 30e6 };
    expect(planPlayback(heavy, chrome, { quality: '1080p' })).toMatchObject({
      mode: 'transcode',
      video: { height: 1080 },
    });
  });

  it('remuxes to switch to another audio track', () => {
    const file = { ...uhd, audioTracks: [track(1, 'aac', true), track(2, 'aac')] };
    expect(planPlayback(file, chrome, { audioTrack: 2 })).toMatchObject({
      mode: 'remux',
      audio: { mode: 'copy' },
      audioTrack: 2,
      reasons: [{ kind: 'track' }],
    });
    expect(planPlayback(file, chrome, { audioTrack: 1 }).mode).toBe('direct');
  });

  it('repackages a file the device failed to play directly', () => {
    expect(planPlayback(uhd, chrome, { noDirect: true })).toMatchObject({
      mode: 'remux',
      video: { mode: 'copy' },
      audio: { mode: 'copy' },
      reasons: [{ kind: 'container', codec: 'mkv' }],
    });
  });

  it('converts audio to Opus when the device has no AAC', () => {
    const vp9 = { ...uhd, videoCodec: 'vp9', height: 1080, bitDepth: 8, bitrate: 5e6 };
    expect(planPlayback({ ...vp9, audioTracks: [track(1, 'eac3', true)] }, chromium)).toMatchObject(
      {
        mode: 'remux',
        audio: { mode: 'transcode', codec: 'opus' },
      },
    );
  });

  it('gives up when nothing works', () => {
    expect(planPlayback(uhd, chromium)).toEqual({
      mode: 'unplayable',
      reasons: [
        { kind: 'video', codec: 'hevc' },
        { kind: 'audio', codec: 'aac' },
      ],
    });
    // Without HLS only direct play is possible.
    expect(planPlayback(uhd, device(['mp4a.40.2'], false)).mode).toBe('unplayable');
  });

  it('handles files without audio', () => {
    const silent = { ...uhd, audioTracks: [] };
    const plan = planPlayback(silent, firefox);
    expect(plan).toMatchObject({ mode: 'transcode' });
    expect(plan).not.toHaveProperty('audio');
  });
});

describe('transcodeBitrate', () => {
  it('scales with the height', () => {
    expect([480, 720, 1080, 1440, 2160].map(transcodeBitrate)).toEqual([2e6, 4e6, 8e6, 12e6, 20e6]);
  });

  it('remuxes 4K HEVC in Matroska for Safari, keeping the picture and the Dolby audio', () => {
    const file = { ...uhd, audioTracks: [track(1, 'eac3', true)] };
    expect(planPlayback(file, safari)).toEqual({
      mode: 'remux',
      video: { mode: 'copy' },
      audio: { mode: 'copy' },
      audioTrack: 1,
      reasons: [{ kind: 'container', codec: 'mkv' }],
    });
    // TrueHD becomes AAC.
    expect(planPlayback({ ...uhd, audioTracks: [track(1, 'truehd', true)] }, safari)).toMatchObject(
      { mode: 'remux', audio: { mode: 'transcode', codec: 'aac' } },
    );
  });
});
