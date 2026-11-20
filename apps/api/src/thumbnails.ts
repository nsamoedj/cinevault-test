// Preview pictures for the timeline ("trickplay", CLAUDE.md "Voorbeeldbeelden"):
// while nobody watches, the transcoder makes small pictures of each file, one
// sheet of 5 × 5 at a time, newest files first. A sheet that is done stays
// done, so a pass that stops (someone starts watching) goes on there later.
//
// Kept in CACHE_DIR/thumbnails/<fileId>/<version>/: 0.jpg, 1.jpg … and
// index.json once all sheets are there; "failed" when FFmpeg cannot read the
// file. The version changes with the file (size, mtime) and with the layout.

import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ThumbnailInfo, Thumbnails } from '@cinevault/shared';
import type { PrismaClient } from './generated/prisma/client.js';
import { type TranscoderClient, TranscoderError } from './transcoder.js';

/** One picture: 320 pixels wide, as high as the video's shape needs. */
const WIDTH = 320;
const COLUMNS = 5;
const ROWS = 5;
/** A picture every 10 s; fewer for long films (at most about 400). */
const MIN_INTERVAL = 10;
const MAX_PICTURES = 400;
/** Shorter files (trailers, extras) need no previews. */
const MIN_DURATION_MS = 2 * 60_000;
/** Bump when the pictures would look different: makes them anew. */
const LAYOUT = 1;
/** The transcoder unreachable or too old: try again after this long. */
const PAUSE_MS = 15 * 60_000;
/** Another error (not the file): try that file again after this long. */
const RETRY_MS = 6 * 60 * 60_000;

export interface ThumbnailServiceOptions {
  prisma: PrismaClient;
  cacheDir: string;
  transcoder?: TranscoderClient;
  /** Nobody watches (the intro search's activity); without it, always. */
  idle?: () => boolean;
  log?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
  now?: () => number;
  /** Files shorter than this get none (default 2 minutes; the browser tests use short files). */
  minDurationMs?: number;
}

interface FileRow {
  id: string;
  path: string;
  size: bigint;
  modifiedAt: Date;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hdrFormat: string | null;
}

/** How a file's pictures are laid out. */
interface Layout {
  version: string;
  interval: number;
  width: number;
  height: number;
  count: number;
  sheets: number;
}

const FILE_SELECT = {
  id: true,
  path: true,
  size: true,
  modifiedAt: true,
  width: true,
  height: true,
  durationMs: true,
  hdrFormat: true,
} as const;

const even = (value: number) => Math.max(16, Math.round(value / 2) * 2);

export function layoutFor(file: FileRow, minDurationMs = MIN_DURATION_MS): Layout | undefined {
  if (!file.width || !file.height || !file.durationMs || file.durationMs < minDurationMs) {
    return undefined;
  }
  const seconds = file.durationMs / 1000;
  const interval = Math.max(MIN_INTERVAL, Math.ceil(seconds / MAX_PICTURES));
  const count = Math.floor((seconds - 1) / interval) + 1;
  const version = createHash('sha256')
    .update(`${file.id}:${file.size}:${file.modifiedAt.getTime()}:${LAYOUT}`)
    .digest('hex')
    .slice(0, 16);
  return {
    version,
    interval,
    width: WIDTH,
    height: Math.min(640, even((WIDTH * file.height) / file.width)),
    count,
    sheets: Math.ceil(count / (COLUMNS * ROWS)),
  };
}

export class ThumbnailService {
  private readonly options: ThumbnailServiceOptions;
  private readonly dir: string;
  private readonly failed = new Map<string, number>();
  private pausedUntil = 0;
  private passing = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ThumbnailServiceOptions) {
    this.options = options;
    this.dir = path.join(options.cacheDir, 'thumbnails');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private layout(file: FileRow): Layout | undefined {
    return layoutFor(file, this.options.minDurationMs);
  }

  private folder(fileId: string, version: string): string {
    return path.join(this.dir, fileId, version);
  }

  /** The previews of a file, or whether they are still to come. */
  async info(fileId: string): Promise<ThumbnailInfo | undefined> {
    const file = await this.options.prisma.mediaFile.findUnique({
      where: { id: fileId },
      select: FILE_SELECT,
    });
    if (!file) return undefined;
    const layout = this.layout(file);
    if (!layout) return { pending: false };
    const folder = this.folder(file.id, layout.version);
    if (await exists(path.join(folder, 'index.json'))) {
      const thumbnails: Thumbnails = {
        interval: layout.interval,
        width: layout.width,
        height: layout.height,
        columns: COLUMNS,
        rows: ROWS,
        count: layout.count,
        sheets: Array.from(
          { length: layout.sheets },
          (_, n) => `/api/files/${file.id}/thumbnails/${layout.version}/${n}.jpg`,
        ),
      };
      return { thumbnails, pending: false };
    }
    const failed = await exists(path.join(folder, 'failed'));
    return { pending: Boolean(this.options.transcoder) && !failed };
  }

  /** A sheet on disk, if it is there. */
  async sheet(fileId: string, version: string, n: number): Promise<string | undefined> {
    const file = path.join(this.folder(fileId, version), `${n}.jpg`);
    return (await exists(file)) ? file : undefined;
  }

  /**
   * Makes the previews of files that have none, newest first, one sheet at a
   * time, as long as nobody watches. Returns the files finished.
   */
  async runOnce(): Promise<number> {
    const transcoder = this.options.transcoder;
    if (!transcoder || this.passing || this.now() < this.pausedUntil) return 0;
    if (!this.idle()) return 0;
    this.passing = true;
    try {
      const files = await this.options.prisma.mediaFile.findMany({
        where: {
          durationMs: { gte: this.options.minDurationMs ?? MIN_DURATION_MS },
          width: { not: null },
        },
        select: FILE_SELECT,
        orderBy: [{ addedAt: 'desc' }, { path: 'asc' }],
      });
      await this.forgetGone(new Set(files.map((f) => f.id)));
      let done = 0;
      for (const file of files) {
        const layout = this.layout(file);
        if (!layout) continue;
        const folder = this.folder(file.id, layout.version);
        if (await exists(path.join(folder, 'index.json'))) continue;
        if (await exists(path.join(folder, 'failed'))) continue;
        const failedAt = this.failed.get(`${file.id}:${layout.version}`);
        if (failedAt !== undefined && this.now() - failedAt < RETRY_MS) continue;
        const result = await this.make(transcoder, file, layout);
        if (result === 'done') done++;
        if (result === 'stopped') break;
      }
      return done;
    } finally {
      this.passing = false;
    }
  }

  private idle(): boolean {
    return this.options.idle ? this.options.idle() : true;
  }

  private async make(
    transcoder: TranscoderClient,
    file: FileRow,
    layout: Layout,
  ): Promise<'done' | 'failed' | 'stopped'> {
    const folder = this.folder(file.id, layout.version);
    await mkdir(folder, { recursive: true });
    const perSheet = COLUMNS * ROWS;
    for (let n = 0; n < layout.sheets; n++) {
      const target = path.join(folder, `${n}.jpg`);
      if (await exists(target)) continue;
      if (!this.idle()) return 'stopped';
      const times: number[] = [];
      for (let i = n * perSheet; i < Math.min(layout.count, (n + 1) * perSheet); i++) {
        times.push(i * layout.interval);
      }
      try {
        const jpeg = await transcoder.thumbnails({
          path: file.path,
          times,
          width: layout.width,
          height: layout.height,
          columns: COLUMNS,
          ...(file.hdrFormat && { hdr: true }),
        });
        await writeFile(`${target}.tmp`, jpeg);
        await rename(`${target}.tmp`, target);
      } catch (error) {
        if (error instanceof TranscoderError && error.statusCode === 422) {
          // This file: FFmpeg cannot read pictures from it.
          await writeFile(path.join(folder, 'failed'), error.message).catch(() => {});
          this.options.log?.warn({ err: error, fileId: file.id }, 'thumbnails: unreadable file');
          return 'failed';
        }
        if (!(error instanceof TranscoderError) || error.statusCode >= 500) {
          // The transcoder, not this file: later.
          this.pausedUntil = this.now() + PAUSE_MS;
          this.options.log?.warn({ err: error }, 'thumbnails: the transcoder cannot make them now');
          return 'stopped';
        }
        this.failed.set(`${file.id}:${layout.version}`, this.now());
        this.options.log?.warn({ err: error, fileId: file.id }, 'thumbnails: could not make them');
        return 'failed';
      }
    }
    await writeFile(
      path.join(folder, 'index.json'),
      JSON.stringify({ ...layout, columns: COLUMNS, rows: ROWS }),
    );
    await this.forgetOthers(file.id, layout.version);
    this.options.log?.info({ fileId: file.id, sheets: layout.sheets }, 'thumbnails: made');
    return 'done';
  }

  /** Pictures of an earlier version of the file. */
  private async forgetOthers(fileId: string, keep: string): Promise<void> {
    const versions = await readdir(path.join(this.dir, fileId)).catch(() => [] as string[]);
    for (const version of versions) {
      if (version !== keep) {
        await rm(path.join(this.dir, fileId, version), { recursive: true, force: true });
      }
    }
  }

  /** Pictures of files that are gone from the library. */
  private async forgetGone(known: Set<string>): Promise<void> {
    // No files (a database that is not there yet): keep everything.
    if (known.size === 0) return;
    const ids = await readdir(this.dir).catch(() => [] as string[]);
    for (const id of ids) {
      if (!known.has(id)) await rm(path.join(this.dir, id), { recursive: true, force: true });
    }
  }

  /** Every minute; a pass goes on as long as nobody watches. */
  start(intervalMs = 60_000): void {
    const tick = () => {
      this.runOnce().catch((error: unknown) =>
        this.options.log?.warn({ err: error }, 'thumbnails: a pass failed'),
      );
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
