// What this phone plays, for planPlayback (packages/shared): the codec
// strings the web app asks the browser about, answered by Android's decoders.

import type { PlaybackCapabilities } from '@cinevault/shared';

export type DecoderCheck = (
  mime: string,
  options: { profile?: number; width?: number; height?: number },
) => boolean;

// MediaCodecInfo.CodecProfileLevel
const HEVC_MAIN = 1;
const HEVC_MAIN10 = 2;
const AVC_HIGH = 8;
const VP9_PROFILE0 = 1;
const VP9_PROFILE2 = 4;
const AV1_MAIN8 = 1;
const AV1_MAIN10 = 2;

const UHD = { width: 3840, height: 2160 };
const FHD = { width: 1920, height: 1080 };

const AUDIO: Record<string, string> = {
  'mp4a.40.2': 'audio/mp4a-latm',
  'mp4a.6b': 'audio/mpeg',
  opus: 'audio/opus',
  vorbis: 'audio/vorbis',
  flac: 'audio/flac',
  'ac-3': 'audio/ac3',
  'ec-3': 'audio/eac3',
  dtsc: 'audio/vnd.dts',
  mlpa: 'audio/true-hd',
};

/** One RFC 6381 codec ("hvc1.2.4.L153.B0", "ec-3") on this device. */
export function codecSupported(codec: string, check: DecoderCheck): boolean {
  const audio = AUDIO[codec];
  if (audio) return check(audio, {});
  const [family, ...parts] = codec.split('.');
  switch (family) {
    case 'avc1': {
      // avc1.PPCCLL: level 0x33 (5.1) for 4K.
      const level = parseInt(codec.slice(9, 11), 16);
      return check('video/avc', { profile: AVC_HIGH, ...(level >= 0x33 ? UHD : FHD) });
    }
    case 'hvc1':
    case 'hev1': {
      // hvc1.<profile>.<compat>.L<level>.<constraints>
      const profile = parts[0] === '2' ? HEVC_MAIN10 : HEVC_MAIN;
      const level = Number(parts[2]?.slice(1) ?? 0);
      return check('video/hevc', { profile, ...(level >= 150 ? UHD : FHD) });
    }
    case 'vp09': {
      const profile = parts[0] === '02' ? VP9_PROFILE2 : VP9_PROFILE0;
      const level = Number(parts[1] ?? 0);
      return check('video/x-vnd.on2.vp9', { profile, ...(level >= 50 ? UHD : FHD) });
    }
    case 'av01': {
      const tenBit = parts[2] === '10';
      const level = parseInt(parts[1] ?? '0', 10);
      return check('video/av01', {
        profile: tenBit ? AV1_MAIN10 : AV1_MAIN8,
        ...(level >= 12 ? UHD : FHD),
      });
    }
    default:
      return false;
  }
}

/**
 * Android's player (ExoPlayer) reads MP4, Matroska and WebM and plays HLS
 * itself, so only the codecs decide.
 */
export function androidDevice(check: DecoderCheck): PlaybackCapabilities {
  const cache = new Map<string, boolean>();
  return {
    hls: true,
    matroska: true,
    canPlay(mime) {
      const known = cache.get(mime);
      if (known !== undefined) return known;
      const codecs = /codecs="([^"]+)"/.exec(mime)?.[1];
      const result = codecs
        ? codecs.split(',').every((codec) => codecSupported(codec.trim(), check))
        : /^(video|audio)\/(mp4|webm|x-matroska)$/.test(mime.trim());
      cache.set(mime, result);
      return result;
    },
  };
}

/**
 * The device without codecs that failed while playing: a decoder can be
 * listed (and claim support) yet refuse to work for an app, as some phones'
 * Dolby decoders do with E-AC3.
 */
export function withoutCodecs(
  device: PlaybackCapabilities,
  failed: readonly string[],
): PlaybackCapabilities {
  if (failed.length === 0) return device;
  return {
    ...device,
    canPlay(mime) {
      const codecs = /codecs="([^"]+)"/.exec(mime)?.[1]?.split(',') ?? [];
      return !codecs.some((codec) => failed.includes(codec.trim())) && device.canPlay(mime);
    },
  };
}
