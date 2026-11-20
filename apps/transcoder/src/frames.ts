// Brightness statistics of single frames, for finding the end credits of a
// film (the API decides: apps/api/src/intro/film.ts). Films have no other
// episodes to compare the audio with, so the picture tells: rolling credits
// are a dark frame with a little light text in lines, minute after minute.
//
// Like the timeline previews, every time is its own short FFmpeg run on the
// keyframe at or before it: a few MB read, not the last 20 minutes of a 60 GB
// remux. It reports where that keyframe really is, so a scene after the
// credits is found to its first cut.

import type { TranscoderConfig } from './config.ts';
import { type Logger, resolveMedia, SessionError } from './sessions.ts';
import { HDR_TO_SDR, runFfmpeg } from './thumbnails.ts';

export interface FrameStatsRequest {
  path: string;
  /** Seconds in the file, one frame each. */
  times: number[];
  /** HDR (PQ, HLG): tone mapped first, so text is as bright as in SDR. */
  hdr?: boolean;
  /** FFmpeg runs at once (1-4): more while nobody watches. */
  jobs?: number;
}

export interface FrameStats {
  /** The time asked for, and where the keyframe used is (at or before it). */
  time: number;
  at: number;
  /** Shares of the frame: dark (< 50), bright (> 150), and between. */
  dark: number;
  mid: number;
  bright: number;
  /** Rows with bright pixels, and how many bright pixels such a row has on average. */
  rows: number;
  perRow: number;
}

export interface FrameStatsResult {
  samples: FrameStats[];
}

export const WIDTH = 320;
export const HEIGHT = 180;
const DARK = 50;
const BRIGHT = 150;
/** A row with this many bright pixels has text (or a light) in it. */
const ROW_PIXELS = 3;

/** The statistics of one grey frame (WIDTH × HEIGHT, one byte a pixel). */
export function frameStats(frame: Uint8Array): Omit<FrameStats, 'time' | 'at'> {
  let dark = 0;
  let bright = 0;
  let rows = 0;
  for (let y = 0; y < HEIGHT; y++) {
    let inRow = 0;
    for (let x = 0; x < WIDTH; x++) {
      const value = frame[y * WIDTH + x] as number;
      if (value < DARK) dark++;
      else if (value > BRIGHT) inRow++;
    }
    bright += inRow;
    if (inRow >= ROW_PIXELS) rows++;
  }
  const size = WIDTH * HEIGHT;
  const share = (n: number) => Math.round((n / size) * 1e5) / 1e5;
  return {
    dark: share(dark),
    mid: share(size - dark - bright),
    bright: share(bright),
    rows,
    perRow: rows > 0 ? Math.round((bright / rows) * 10) / 10 : 0,
  };
}

export function statsArgs(input: string, seconds: number, tonemap: boolean): string[] {
  const filters = [
    // Nearest pixels: thin letters keep their brightness (an average would grey them out).
    `scale=${WIDTH}:${HEIGHT}:flags=neighbor`,
    ...(tonemap ? [HDR_TO_SDR] : []),
    'format=gray',
    // Logs the frame's time (pts_time, from the seek point).
    'showinfo',
  ];
  // prettier-ignore
  return [
    '-hide_banner', '-nostats', '-loglevel', 'info',
    '-skip_frame', 'nokey', '-noaccurate_seek',
    ...(seconds > 0 ? ['-ss', seconds.toFixed(3)] : []),
    '-threads', '2',
    '-i', input,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-frames:v', '1', '-vf', filters.join(','),
    '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ];
}

/** Where the frame FFmpeg gave is: the seek point plus showinfo's first pts_time. */
export function keyframeTime(seconds: number, log: string): number {
  const match = /pts_time:(-?[\d.]+)/.exec(log);
  const offset = match ? Number(match[1]) : 0;
  return Math.max(0, Math.round((seconds + (Number.isFinite(offset) ? offset : 0)) * 1000) / 1000);
}

export class FrameStatsJobs {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: TranscoderConfig;
  private readonly log: Logger;

  constructor(config: TranscoderConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  /** One at a time (it reads from the same disks as the streams); dropped when the caller went away. */
  stats(request: FrameStatsRequest, signal?: AbortSignal): Promise<FrameStatsResult> {
    const next = this.queue.then(() => {
      if (signal?.aborted) throw new SessionError(499, 'frame statistics cancelled');
      return this.run(request, signal);
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async run(request: FrameStatsRequest, signal?: AbortSignal): Promise<FrameStatsResult> {
    const started = Date.now();
    const input = await resolveMedia(this.config.mediaRoot, request.path);
    let tonemap = Boolean(request.hdr);
    let lastError = '';
    const samples: FrameStats[] = [];
    const grabOne = async (time: number) => {
      if (signal?.aborted) return;
      let log = '';
      const grab = (withTonemap: boolean) =>
        runFfmpeg(this.config.ffmpeg, statsArgs(input, time, withTonemap), undefined, 30_000, {
          ...(signal && { signal }),
          log: (text) => (log = text),
        });
      const withTonemap = tonemap;
      let frame = await grab(withTonemap).catch((error: Error) => {
        lastError = error.message;
        return undefined;
      });
      if (!frame && withTonemap && !signal?.aborted) {
        // No zscale in this FFmpeg, or a file without colour tags.
        tonemap = false;
        frame = await grab(false).catch(() => undefined);
      }
      // A time past the last keyframe gives nothing: left out.
      if (!frame || frame.length < WIDTH * HEIGHT) return;
      samples.push({
        time,
        at: keyframeTime(time, log),
        ...frameStats(frame.subarray(0, WIDTH * HEIGHT)),
      });
    };
    // Each run seeks to one keyframe and decodes it: a few at once keep the CPU busy.
    const jobs = Math.max(1, Math.min(4, Math.round(request.jobs ?? 1)));
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(jobs, request.times.length) }, async () => {
        while (next < request.times.length) await grabOne(request.times[next++] as number);
      }),
    );
    samples.sort((a, b) => a.time - b.time);
    if (signal?.aborted) throw new SessionError(499, 'frame statistics cancelled');
    if (samples.length === 0) {
      // 422: this file, not the transcoder (the API marks it and goes on).
      throw new SessionError(422, `ffmpeg could not read pictures: ${lastError || 'no frames'}`);
    }
    this.log.info(
      `frame statistics ${request.path}: ${samples.length}/${request.times.length} from ` +
        `${request.times[0]?.toFixed(0)} s, ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    return { samples };
  }
}
