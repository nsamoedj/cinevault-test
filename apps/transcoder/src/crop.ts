// Black bars that are part of the picture, such as a 2.39:1 film in a 16:9
// frame: FFmpeg's cropdetect on a few keyframes spread over the file. Only
// keyframes are decoded (-skip_frame nokey), so this takes seconds, also for
// 4K. The players use it to fill a screen with the picture, not the bars.

import type { TranscoderConfig } from './config.ts';
import { run } from './run.ts';
import { type Logger, resolveMedia } from './sessions.ts';

export interface CropBox {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Where in the file to look: dark scenes look like bars, so look in several. */
const POINTS = [0.12, 0.27, 0.42, 0.57, 0.72, 0.87];
/** Keyframes per point; cropdetect keeps the widest box it saw. */
const FRAMES = 3;

/** The last box cropdetect reported (it grows over the frames of one run). */
export function lastCrop(stderr: string): CropBox | undefined {
  let found: CropBox | undefined;
  for (const match of stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
    const [width, height, x, y] = match.slice(1).map(Number) as [number, number, number, number];
    if (width > 0 && height > 0) found = { width, height, x, y };
  }
  return found;
}

/** The smallest box around all boxes: picture seen anywhere is picture. */
export function unionCrop(boxes: CropBox[]): CropBox | undefined {
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export class CropDetector {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: TranscoderConfig;
  private readonly log: Logger;

  constructor(config: TranscoderConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  /** One file at a time: this reads from the same disks as the streams. */
  detect(relPath: string, durationSeconds: number): Promise<CropBox | undefined> {
    const next = this.queue.then(() => this.run(relPath, durationSeconds));
    this.queue = next.catch(() => {});
    return next;
  }

  private async run(relPath: string, durationSeconds: number): Promise<CropBox | undefined> {
    const input = await resolveMedia(this.config.mediaRoot, relPath);
    const boxes: CropBox[] = [];
    for (const point of POINTS) {
      // prettier-ignore
      const result = await run(this.config.ffmpeg, [
        '-hide_banner', '-nostats', '-loglevel', 'info',
        '-skip_frame', 'nokey', '-ss', (durationSeconds * point).toFixed(3), '-i', input,
        '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', 'cropdetect=limit=0.1:round=2:skip=0:reset=0',
        '-frames:v', String(FRAMES), '-f', 'null', '-',
      ], { timeoutMs: 30_000 });
      const box = lastCrop(result.stderr);
      if (box) boxes.push(box);
    }
    const crop = unionCrop(boxes);
    this.log.info(
      `crop ${relPath}: ${crop ? `${crop.width}x${crop.height}+${crop.x}+${crop.y}` : 'none'}`,
    );
    return crop;
  }
}
