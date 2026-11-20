// FFmpeg command lines for HLS sessions (fMP4 segments, played with hls.js).
//
// On the N100 frames stay on the GPU: QSV decodes, vpp_qsv scales (and tone
// maps HDR), h264_qsv encodes. Uploading CPU frames to QSV fails there
// (CLAUDE.md), so sources QSV can't decode are encoded on the CPU instead.

import type { AudioPlan, VideoPlan } from '@cinevault/shared';

export interface SourceInfo {
  videoCodec?: string;
  width?: number;
  height?: number;
  bitDepth?: number;
  hdrFormat?: string;
  /** Dolby Vision profile, when the API knows it. */
  dvProfile?: number;
}

/** What the API asks for (POST /sessions). */
export interface Job {
  /** Relative to MEDIA_ROOT, "/"-separated. */
  path: string;
  start: number;
  video: VideoPlan;
  audio?: AudioPlan;
  /** Absolute stream index of the audio track. */
  audioTrack?: number;
  source: SourceInfo;
}

export interface Capabilities {
  hwaccel: 'qsv' | 'none';
  /** vpp_qsv can tone map HDR to SDR. */
  tonemap: boolean;
  /** FFmpeg 7.1+: -readrate needs -readrate_catchup (see readrateArgs). */
  readrateCatchup?: boolean;
  /**
   * h264_qsv only encodes in low-power mode (VDEnc), as Intel's Linux driver
   * may require on GPUs such as the N100's; the self test finds out.
   */
  lowPower?: boolean;
}

/** As good as no limit: catching up as fast as the disk and decoder go. */
const READRATE_CATCHUP = 10_000;

/**
 * -readrate, and what FFmpeg 7.1 and newer need to read as FFmpeg 6 did.
 * Those versions take a read that runs ahead (the initial burst, or a high
 * -readrate the reading can't keep up exactly) for lagging behind, and then
 * read at -readrate_catchup, which is slow unless given. With FFmpeg 8 a
 * session's first minute came at 1.5x real time instead of at once, and a
 * fingerprint asked at 50x read at 2x (measured 2026-11-17).
 */
export function readrateArgs(rate: number, catchup: boolean, burstSeconds?: number): string[] {
  const args = ['-readrate', String(rate)];
  if (burstSeconds !== undefined) args.push('-readrate_initial_burst', String(burstSeconds));
  if (catchup) args.push('-readrate_catchup', String(Math.max(READRATE_CATCHUP, rate)));
  return args;
}

export interface ArgsOptions {
  input: string;
  /** Where the stream starts (a keyframe for remuxes). */
  start: number;
  segmentSeconds: number;
  readrate: number;
  readrateBurstSeconds: number;
}

/** Sources the N100's QSV decodes; 10-bit H.264 (old anime encodes) it does not. */
export function qsvDecodes(source: SourceInfo): boolean {
  switch (source.videoCodec) {
    case 'h264':
      return (source.bitDepth ?? 8) <= 8;
    case 'hevc':
    case 'av1':
    case 'vp9':
    case 'mpeg2video':
      return true;
    default:
      return false;
  }
}

/**
 * The output size for a quality (its height): the source's aspect ratio kept,
 * inside a 16:9 box of that height (1920x1080 for 1080p), rounded to even
 * numbers. A wide film at 1080p is 1920x804, not 2580x1080: TV decoders for
 * H.264 often stop at 1920 wide (NO_EXCEEDS_CAPABILITIES, Google TV 2026-10-24).
 */
export function outputSize(source: SourceInfo, height: number): { width: number; height: number } {
  const boxWidth = (height * 16) / 9;
  if (!source.width || !source.height) return { width: even(boxWidth), height: even(height) };
  const scale = Math.min(boxWidth / source.width, height / source.height);
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export type VideoPath = 'copy' | 'qsv' | 'cpu';

export function videoPath(job: Job, caps: Capabilities): VideoPath {
  if (job.video.mode === 'copy') return 'copy';
  return caps.hwaccel === 'qsv' && qsvDecodes(job.source) ? 'qsv' : 'cpu';
}

const kbit = (bps: number) => `${Math.round(bps / 1000)}k`;

/** More than FFmpeg's 3/23 s, less than the distance between two keyframes. */
const KEYFRAME_MARGIN = 0.15;

export function buildArgs(job: Job, caps: Capabilities, options: ArgsOptions): string[] {
  const path = videoPath(job, caps);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];

  if (path === 'qsv') args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
  // Throttle: a burst to fill the player's buffer, then a little faster than real time.
  if (options.readrate > 0) {
    args.push(
      ...readrateArgs(
        options.readrate,
        caps.readrateCatchup ?? false,
        options.readrateBurstSeconds,
      ),
    );
  }
  if (options.start > 0 && job.video.mode === 'copy') {
    // A remux starts at a keyframe (`start`, see keyframeBefore). FFmpeg seeks
    // a fixed 3/23 s earlier in formats such as MKV, so at `start` itself it
    // lands on the keyframe before: the copied video began there, and the
    // converted audio (cut exactly at -ss) seconds later. Android's player
    // then played them out of sync (an anime with DTS audio, 2026-10-19).
    // Just past the keyframe, without cutting the audio, both start at it.
    args.push('-noaccurate_seek', '-ss', (options.start + KEYFRAME_MARGIN).toFixed(3));
  } else if (options.start > 0) {
    args.push('-ss', options.start.toFixed(3));
  }
  args.push('-i', options.input);

  args.push('-map', '0:v:0');
  if (job.audio && job.audioTrack !== undefined) args.push('-map', `0:${job.audioTrack}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn');

  if (job.video.mode === 'copy') {
    args.push('-c:v', 'copy');
    // Browsers want HEVC in MP4 tagged hvc1; Dolby Vision profile 5 (no HDR10
    // base) dvh1. For DV, "unofficial" lets FFmpeg write the dvcC box, so a DV
    // player (Safari) shows it as DV and others use the HDR10 base (profile 8).
    if (job.source.videoCodec === 'hevc') {
      const dv = job.source.hdrFormat === 'DV';
      args.push('-tag:v', dv && job.source.dvProfile === 5 ? 'dvh1' : 'hvc1');
      if (dv) args.push('-strict', 'unofficial');
    }
  } else {
    const { bitrate } = job.video;
    const { width, height } = outputSize(job.source, job.video.height);
    const hdr = Boolean(job.source.hdrFormat);
    const rate = [
      '-b:v',
      kbit(bitrate),
      '-maxrate',
      kbit(bitrate * 1.5),
      '-bufsize',
      kbit(bitrate * 2),
    ];
    // Keyframes every 96 frames (4 s at 24 fps) so segments can split often.
    const gop = ['-g', '96'];
    if (path === 'qsv') {
      const tonemap = hdr && caps.tonemap ? ':tonemap=1' : '';
      args.push('-vf', `vpp_qsv=w=${width}:h=${height}:format=nv12${tonemap}`);
      args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'high', ...rate, ...gop);
      if (caps.lowPower) args.push('-low_power', '1');
    } else {
      args.push('-vf', `scale=${width}:${height},format=yuv420p`);
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', ...rate, ...gop);
    }
    if (hdr && path === 'qsv' && caps.tonemap) {
      // Label the tone mapped result as BT.709 so players show it as SDR.
      args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    }
  }

  if (job.audio) {
    if (job.audio.mode === 'copy') {
      args.push('-c:a', 'copy');
    } else {
      const codec = job.audio.codec === 'aac' ? 'aac' : 'libopus';
      args.push('-c:a', codec, '-ac', String(job.audio.channels), '-b:a', kbit(job.audio.bitrate));
    }
  } else {
    args.push('-an');
  }

  args.push(
    '-max_muxing_queue_size',
    '1024',
    '-f',
    'hls',
    '-hls_time',
    String(options.segmentSeconds),
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    'seg_%05d.m4s',
    '-hls_flags',
    'independent_segments+temp_file',
    // No edit lists: where a track starts goes into its own timestamps. FFmpeg
    // otherwise puts it in an edit list, which ExoPlayer (Android, the TV)
    // and hls.js ignore; after a start halfway, the picture then began too
    // early and the sound came late (the TV app, 2026-11-04).
    '-hls_segment_options',
    'use_editlist=0',
    '-start_number',
    '0',
    // Relative names: FFmpeg runs in the session folder.
    'index.m3u8',
  );
  return args;
}
