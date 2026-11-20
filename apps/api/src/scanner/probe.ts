import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioTrack, HdrFormat, SubtitleTrack } from '@cinevault/shared';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  container?: string;
  videoCodec?: string;
  width?: number;
  height?: number;
  bitDepth?: number;
  hdrFormat?: HdrFormat;
  /** Dolby Vision: the profile (5, 7, 8) and the base layer's compatibility (1 HDR10, 4 HLG …). */
  dvProfile?: number;
  dvCompatibility?: number;
  durationMs?: number;
  bitrate?: number;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
}

// The subset of `ffprobe -print_format json -show_format -show_streams` we use.
interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_transfer?: string;
  channels?: number;
  channel_layout?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: {
    side_data_type?: string;
    dv_profile?: number;
    dv_bl_signal_compatibility_id?: number;
  }[];
}

export interface FfprobeOutput {
  format?: { format_name?: string; duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

function containerName(formatName: string | undefined): string | undefined {
  if (!formatName) return undefined;
  if (formatName.startsWith('matroska')) return 'mkv';
  if (formatName.startsWith('mov,mp4')) return 'mp4';
  if (formatName === 'mpegts') return 'ts';
  return formatName.split(',')[0];
}

function bitDepth(stream: FfprobeStream): number | undefined {
  const raw = Number(stream.bits_per_raw_sample);
  if (Number.isInteger(raw) && raw > 0) return raw;
  const pixFmt = stream.pix_fmt ?? '';
  if (!pixFmt) return undefined;
  if (/^nv(12|21)$/.test(pixFmt)) return 8;
  const match = /(\d{2})(?:le|be)?$/.exec(pixFmt);
  return match ? Number(match[1]) : 8;
}

function hdrFormat(stream: FfprobeStream): HdrFormat | undefined {
  const sideData = stream.side_data_list ?? [];
  if (sideData.some((d) => d.side_data_type?.startsWith('DOVI configuration'))) return 'DV';
  if (stream.color_transfer === 'smpte2084') return 'HDR10';
  if (stream.color_transfer === 'arib-std-b67') return 'HLG';
  return undefined;
}

function positive(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function tag(stream: FfprobeStream, name: string): string | undefined {
  const value = stream.tags?.[name] ?? stream.tags?.[name.toUpperCase()];
  return value && value !== 'und' ? value : undefined;
}

export function mapProbe(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  // Cover art in MKV/MP4 shows up as a video stream with attached_pic.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = positive(output.format?.duration);
  const bitrate = positive(output.format?.bit_rate);

  const audioTracks: AudioTrack[] = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      ...(tag(s, 'language') && { language: tag(s, 'language') }),
      ...(s.channels && { channels: s.channels }),
      ...(s.channel_layout && { layout: s.channel_layout }),
      ...(tag(s, 'title') && { title: tag(s, 'title') }),
      default: s.disposition?.default === 1,
    }));

  const subtitleTracks: SubtitleTrack[] = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      ...(tag(s, 'language') && { language: tag(s, 'language') }),
      ...(tag(s, 'title') && { title: tag(s, 'title') }),
      forced: s.disposition?.forced === 1,
      default: s.disposition?.default === 1,
      textBased: TEXT_SUBTITLE_CODECS.has(s.codec_name ?? ''),
    }));

  const result: ProbeResult = { audioTracks, subtitleTracks };
  const container = containerName(output.format?.format_name);
  if (container) result.container = container;
  if (duration) result.durationMs = Math.round(duration * 1000);
  if (bitrate) result.bitrate = Math.round(bitrate);
  if (video) {
    if (video.codec_name) result.videoCodec = video.codec_name;
    if (video.width) result.width = video.width;
    if (video.height) result.height = video.height;
    const depth = bitDepth(video);
    if (depth) result.bitDepth = depth;
    const hdr = hdrFormat(video);
    if (hdr) result.hdrFormat = hdr;
    const dovi = (video.side_data_list ?? []).find((d) =>
      d.side_data_type?.startsWith('DOVI configuration'),
    );
    if (dovi && Number.isInteger(dovi.dv_profile)) {
      result.dvProfile = dovi.dv_profile as number;
      if (Number.isInteger(dovi.dv_bl_signal_compatibility_id)) {
        result.dvCompatibility = dovi.dv_bl_signal_compatibility_id as number;
      }
    }
  }
  return result;
}

export interface ProbeOptions {
  ffprobePath?: string;
  timeoutMs?: number;
}

export type Prober = (filePath: string) => Promise<ProbeResult>;

export function createProber(options: ProbeOptions = {}): Prober {
  const ffprobe = options.ffprobePath ?? 'ffprobe';
  return async (filePath) => {
    const { stdout } = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return mapProbe(JSON.parse(stdout) as FfprobeOutput);
  };
}
