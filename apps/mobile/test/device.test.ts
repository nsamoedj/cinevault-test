import { planPlayback } from '@cinevault/shared';
import { describe, expect, it } from 'vitest';
import {
  androidDevice,
  codecSupported,
  type DecoderCheck,
  withoutCodecs,
} from '../src/playback/device';
import { normalizeServer } from '../src/server';

/** A phone: H.264, HEVC Main10 up to 4K, VP9, AAC, Opus; no Dolby or DTS. */
const phone: DecoderCheck = (mime, { profile, width }) => {
  switch (mime) {
    case 'video/avc':
    case 'video/hevc':
    case 'video/x-vnd.on2.vp9':
      return (
        (width ?? 0) <= 3840 && (mime !== 'video/hevc' || profile === undefined || profile <= 2)
      );
    case 'audio/mp4a-latm':
    case 'audio/opus':
    case 'audio/flac':
    case 'audio/mpeg':
      return true;
    default:
      return false;
  }
};

describe('codecSupported', () => {
  it('asks Android about the right decoder, profile and size', () => {
    const asked: [string, unknown][] = [];
    const spy: DecoderCheck = (mime, options) => {
      asked.push([mime, options]);
      return true;
    };
    codecSupported('hvc1.2.4.L153.B0', spy);
    codecSupported('avc1.640028', spy);
    codecSupported('ec-3', spy);
    codecSupported('av01.0.12M.10', spy);
    expect(asked).toEqual([
      ['video/hevc', { profile: 2, width: 3840, height: 2160 }],
      ['video/avc', { profile: 8, width: 1920, height: 1080 }],
      ['audio/eac3', {}],
      ['video/av01', { profile: 2, width: 3840, height: 2160 }],
    ]);
    expect(codecSupported('unknown', spy)).toBe(false);
  });
});

describe('planPlayback on a phone', () => {
  const device = androidDevice(phone);
  const file = {
    container: 'mkv',
    videoCodec: 'hevc',
    width: 3840,
    height: 2160,
    bitDepth: 10,
    bitrate: 60_000_000,
  };

  it('plays 4K HEVC in Matroska directly, with AAC audio', () => {
    expect(
      planPlayback({ ...file, audioTracks: [{ index: 1, codec: 'aac', default: true }] }, device),
    ).toEqual({ mode: 'direct', verdict: 'yes' });
  });

  it('remuxes when the phone has no Dolby decoder: the picture stays, the audio becomes AAC', () => {
    expect(
      planPlayback({ ...file, audioTracks: [{ index: 1, codec: 'eac3', default: true }] }, device),
    ).toMatchObject({
      mode: 'remux',
      video: { mode: 'copy' },
      audio: { mode: 'transcode', codec: 'aac' },
      reasons: [{ kind: 'audio', codec: 'eac3' }],
    });
  });

  it('converts the audio once the Dolby decoder has failed, though it said it could', () => {
    const dolby: DecoderCheck = (mime, options) => mime === 'audio/eac3' || phone(mime, options);
    const eac3 = { ...file, audioTracks: [{ index: 1, codec: 'eac3', default: true }] };
    expect(planPlayback(eac3, androidDevice(dolby))).toEqual({ mode: 'direct', verdict: 'yes' });
    expect(planPlayback(eac3, withoutCodecs(androidDevice(dolby), ['ec-3']))).toMatchObject({
      mode: 'remux',
      video: { mode: 'copy' },
      audio: { mode: 'transcode', codec: 'aac' },
    });
  });

  it('transcodes for a lower quality', () => {
    expect(
      planPlayback({ ...file, audioTracks: [{ index: 1, codec: 'aac', default: true }] }, device, {
        quality: '720p',
      }),
    ).toMatchObject({ mode: 'transcode', video: { mode: 'transcode', height: 720 } });
  });
});

describe('normalizeServer', () => {
  it('adds http:// and drops a trailing slash or /api', () => {
    expect(normalizeServer(' 192.168.0.110:8765/ ')).toBe('http://192.168.0.110:8765');
    expect(normalizeServer('https://cinevault.example.nl/api')).toBe(
      'https://cinevault.example.nl',
    );
  });
});
