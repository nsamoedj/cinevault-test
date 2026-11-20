import { describe, expect, it } from 'vitest';
import { checkDirectPlay, type PlaybackCapabilities, videoCodecString } from '../src/directPlay.js';
import type { AudioTrack } from '../src/index.js';

/** A browser that plays MP4/WebM with the given codecs, and never vouches for Matroska. */
function device(codecs: string[]): PlaybackCapabilities {
  return {
    canPlay(mime) {
      const match = /^(?:video|audio)\/(mp4|webm); codecs="([^"]+)"$/.exec(mime);
      if (!match) return false;
      return (match[2] ?? '').split(', ').every((c) => codecs.includes(c));
    },
  };
}

// Chrome on Windows with hardware HEVC: no AC-3/E-AC3/DTS/TrueHD.
const chrome = device([
  'avc1.640028',
  'avc1.640033',
  'hvc1.2.4.L153.B0',
  'hvc1.1.6.L123.B0',
  'mp4a.40.2',
  'opus',
  'flac',
  'vp09.00.41.08',
]);
// Edge on Windows also decodes Dolby audio.
const edge = device(['avc1.640028', 'hvc1.2.4.L153.B0', 'mp4a.40.2', 'opus', 'ac-3', 'ec-3']);

const track = (codec: string, isDefault = true): AudioTrack => ({
  index: 1,
  codec,
  default: isDefault,
});

describe('Dolby Vision codec strings', () => {
  const dv = { videoCodec: 'hevc', height: 2160, bitDepth: 10, hdrFormat: 'DV' as const };
  it('asks for dvh1 for profile 5, the HDR10 base (hvc1) for profile 8', () => {
    expect(videoCodecString({ ...dv, dvProfile: 5 })).toBe('dvh1.05.06');
    expect(videoCodecString({ ...dv, dvProfile: 8 })).toBe('hvc1.2.4.L153.B0');
    expect(videoCodecString(dv)).toBe('hvc1.2.4.L153.B0');
  });
});

describe('videoCodecString', () => {
  it.each([
    [{ videoCodec: 'h264', height: 1080, bitDepth: 8 }, 'avc1.640028'],
    [{ videoCodec: 'h264', height: 2160, bitDepth: 8 }, 'avc1.640033'],
    [{ videoCodec: 'hevc', height: 2160, bitDepth: 10 }, 'hvc1.2.4.L153.B0'],
    [{ videoCodec: 'hevc', height: 1080, bitDepth: 8 }, 'hvc1.1.6.L123.B0'],
    [{ videoCodec: 'av1', height: 2160, bitDepth: 10 }, 'av01.0.12M.10'],
    [{ videoCodec: 'mpeg4', height: 480, bitDepth: 8 }, undefined],
  ])('%o → %s', (file, expected) => {
    expect(videoCodecString(file)).toBe(expected);
  });
});

describe('checkDirectPlay', () => {
  const uhdHevc = { videoCodec: 'hevc', height: 2160, bitDepth: 10 };

  it('says yes when the device vouches for the exact MP4 combination', () => {
    const result = checkDirectPlay(
      {
        container: 'mp4',
        videoCodec: 'h264',
        height: 1080,
        bitDepth: 8,
        audioTracks: [track('aac')],
      },
      chrome,
    );
    expect(result).toEqual({
      verdict: 'yes',
      problems: [],
      mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    });
  });

  it('says maybe for Matroska with supported codecs', () => {
    const result = checkDirectPlay(
      { container: 'mkv', ...uhdHevc, audioTracks: [track('aac')] },
      chrome,
    );
    expect(result.verdict).toBe('maybe');
  });

  it('does not try Matroska on devices that never play it (Safari)', () => {
    const safari = { ...edge, matroska: false };
    const file = { container: 'mkv', ...uhdHevc, audioTracks: [track('eac3')] };
    expect(checkDirectPlay(file, safari)).toMatchObject({
      verdict: 'no',
      problems: [{ kind: 'container', codec: 'mkv' }],
    });
    // The same codecs in MP4 play directly.
    expect(checkDirectPlay({ ...file, container: 'mp4' }, safari).verdict).toBe('yes');
  });

  it('names the audio codec when that is the problem (4K HEVC with E-AC3 in Chrome)', () => {
    const file = { container: 'mkv', ...uhdHevc, audioTracks: [track('eac3')] };
    expect(checkDirectPlay(file, chrome)).toMatchObject({
      verdict: 'no',
      problems: [{ kind: 'audio', codec: 'eac3' }],
    });
    // Edge decodes E-AC3.
    expect(checkDirectPlay(file, edge).verdict).toBe('maybe');
  });

  it('checks the default audio track, not the first', () => {
    const file = {
      container: 'mkv',
      ...uhdHevc,
      audioTracks: [
        { ...track('truehd', false), index: 1 },
        { ...track('aac'), index: 2 },
      ],
    };
    expect(checkDirectPlay(file, chrome).verdict).toBe('maybe');
  });

  it('refuses formats no browser plays', () => {
    expect(
      checkDirectPlay(
        {
          container: 'avi',
          videoCodec: 'mpeg4',
          height: 480,
          bitDepth: 8,
          audioTracks: [track('dts')],
        },
        chrome,
      ),
    ).toEqual({
      verdict: 'no',
      problems: [
        { kind: 'video', codec: 'mpeg4' },
        { kind: 'container', codec: 'avi' },
      ],
    });
  });

  it('reports a video codec the device lacks', () => {
    const result = checkDirectPlay(
      {
        container: 'mkv',
        videoCodec: 'av1',
        height: 2160,
        bitDepth: 10,
        audioTracks: [track('opus')],
      },
      edge,
    );
    expect(result).toMatchObject({ verdict: 'no', problems: [{ kind: 'video', codec: 'av1' }] });
  });

  it('accepts files without audio', () => {
    expect(
      checkDirectPlay(
        { container: 'mp4', videoCodec: 'h264', height: 1080, bitDepth: 8, audioTracks: [] },
        chrome,
      ).verdict,
    ).toBe('yes');
  });
});
