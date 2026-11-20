// Preview pictures for the timeline ("trickplay"): small pictures of a file
// at regular times, tiled into one JPEG per request (a sheet). The API asks
// for one sheet at a time, only when nobody watches (CLAUDE.md, "Voorbeeldbeelden").
//
// Every picture is its own short FFmpeg run that seeks to the keyframe before
// the time and decodes only that frame. Reading the whole file instead (one run
// with -skip_frame nokey) reads all of a 60 GB 4K remux; seeking reads a few MB.

import { spawn } from 'node:child_process';
import type { TranscoderConfig } from './config.ts';
import { tail } from './run.ts';
import { type Logger, resolveMedia, SessionError } from './sessions.ts';

export interface ThumbnailRequest {
  path: string;
  /** Seconds in the file, one picture each, in the sheet's order. */
  times: number[];
  /** Size of one picture (even numbers). */
  width: number;
  height: number;
  /** Pictures per row of the sheet. */
  columns: number;
  /** HDR (PQ or HLG): tone mapped to SDR, else the colours look washed out. */
  hdr?: boolean;
}

/** HDR to SDR on the CPU (zscale), after scaling down, so it costs little. */
const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,' +
  'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

export const HDR_TO_SDR = TONEMAP;

export function frameArgs(
  input: string,
  seconds: number,
  request: Pick<ThumbnailRequest, 'width' | 'height'>,
  tonemap: boolean,
): string[] {
  const filters = [
    `scale=${request.width}:${request.height}`,
    ...(tonemap ? [TONEMAP] : []),
    'format=yuv420p',
  ];
  // prettier-ignore
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    // The keyframe at or before the time, and only that frame.
    '-skip_frame', 'nokey', '-noaccurate_seek',
    ...(seconds > 0 ? ['-ss', seconds.toFixed(3)] : []),
    '-threads', '2',
    '-i', input,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-frames:v', '1', '-vf', filters.join(','),
    // The keyframe lies before -ss: without this it is dropped as "too early".
    '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-',
  ];
}

export function sheetArgs(request: ThumbnailRequest): string[] {
  const rows = Math.ceil(request.times.length / request.columns);
  // prettier-ignore
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-s', `${request.width}x${request.height}`, '-framerate', '1', '-i', '-',
    '-vf', `tile=${request.columns}x${rows},format=yuvj420p`,
    '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', '-',
  ];
}

export class ThumbnailJobs {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: TranscoderConfig;
  private readonly log: Logger;

  constructor(config: TranscoderConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  /** One sheet at a time: this reads from the same disks as the streams. */
  sheet(request: ThumbnailRequest): Promise<Buffer> {
    const next = this.queue.then(() => this.run(request));
    this.queue = next.catch(() => {});
    return next;
  }

  private async run(request: ThumbnailRequest): Promise<Buffer> {
    const started = Date.now();
    const input = await resolveMedia(this.config.mediaRoot, request.path);
    const size = (request.width * request.height * 3) / 2;
    let tonemap = Boolean(request.hdr);
    let made = 0;
    let lastError = '';
    let previous: Buffer | undefined;
    const frames: Buffer[] = [];
    for (const seconds of request.times) {
      let frame = await this.frame(input, seconds, request, tonemap, size).catch((error: Error) => {
        lastError = error.message;
        return undefined;
      });
      if (!frame && tonemap) {
        // No zscale in this FFmpeg, or a file without colour tags: without it.
        tonemap = false;
        frame = await this.frame(input, seconds, request, false, size).catch(() => undefined);
      }
      if (frame) made++;
      // A time it could not read (past the last keyframe): the picture before it.
      frame ??= previous ?? blackFrame(size, request.width * request.height);
      frames.push(frame);
      previous = frame;
    }
    if (made === 0) {
      // 422: this file, not the transcoder (the API marks it and goes on).
      throw new SessionError(422, `ffmpeg could not read pictures: ${lastError || 'no frames'}`);
    }
    const sheet = await this.tile(request, Buffer.concat(frames));
    this.log.info(
      `thumbnails ${request.path}: ${made}/${request.times.length} from ${request.times[0]?.toFixed(0)} s, ` +
        `${Math.round(sheet.length / 1024)} KiB, ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    return sheet;
  }

  private frame(
    input: string,
    seconds: number,
    request: ThumbnailRequest,
    tonemap: boolean,
    size: number,
  ): Promise<Buffer> {
    return runFfmpeg(
      this.config.ffmpeg,
      frameArgs(input, seconds, request, tonemap),
      undefined,
      30_000,
    ).then((data) => {
      if (data.length < size) throw new Error(`no picture at ${seconds.toFixed(0)} s`);
      return data.subarray(0, size);
    });
  }

  private tile(request: ThumbnailRequest, frames: Buffer): Promise<Buffer> {
    return runFfmpeg(this.config.ffmpeg, sheetArgs(request), frames, 30_000);
  }
}

/** FFmpeg's output (stdout); stdin from `input`. Rejects with the end of its log. */
export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  input: Buffer | undefined,
  timeoutMs: number,
  /** With `log`, FFmpeg's log too (stderr), for what -loglevel info tells. */
  options: { signal?: AbortSignal; log?: (stderr: string) => void } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    if (input && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const cancel = () => child.kill();
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      const data = Buffer.concat(chunks);
      if (code !== 0 || data.length === 0) {
        reject(new Error(tail(stderr) || `exit ${code}`));
        return;
      }
      options.log?.(stderr);
      resolve(data);
    });
  });
}

/** Black in yuv420p: Y 16, U and V 128 (limited range). */
function blackFrame(size: number, lumaSize: number): Buffer {
  const frame = Buffer.alloc(size, 128);
  frame.fill(16, 0, lumaSize);
  return frame;
}
