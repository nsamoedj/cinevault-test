// Picture subtitles (PGS, Blu-ray) as text: FFmpeg copies the track out of
// the file (a .sup), pgs.ts turns it into pictures, and Tesseract (tesseract.js,
// WebAssembly, with English and Dutch built in) reads them. The result is a
// WebVTT kept like an embedded text track read before, so every player can
// show it, shift it, and Chromecast it.
//
// In the background while nobody watches (newest files first, only tracks in
// a language the household reads, and only when the file has no text track in
// that language), and at once when someone picks such a track in a player.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { languageCode, type SubtitleTrack } from '@cinevault/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import { type PgsPicture, readPgs } from './pgs.js';

const require = createRequire(import.meta.url);

/** Languages there is text recognition data for. */
export const OCR_LANGUAGES = ['eng', 'nld'] as const;
export type OcrLanguage = (typeof OCR_LANGUAGES)[number];

export interface OcrEngine {
  read(picture: PgsPicture, language: OcrLanguage): Promise<string>;
  close(): Promise<void>;
}

export type OcrState = 'queued' | 'running' | 'failed';

export interface PgsOcrOptions {
  prisma: PrismaClient;
  mediaRoot: string;
  cacheDir: string;
  engine: OcrEngine;
  /** Keeps the text as the track's WebVTT (SubtitleService.storeEmbedded). */
  store: (fileId: string, streamIndex: number, vtt: string) => Promise<void>;
  ffmpeg?: string;
  /** Nobody watches: background work may start. */
  idle?: () => boolean;
  log?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
}

/** Copying a track out reads the whole file: give a 4K remux time. */
const EXTRACT_TIMEOUT_MS = 60 * 60_000;

/** A track there is text recognition for: PGS, in English, Dutch, or no language. */
export function ocrLanguage(track: SubtitleTrack): OcrLanguage | undefined {
  if (track.textBased || track.codec !== 'hdmv_pgs_subtitle') return undefined;
  const language = languageCode(track.language) ?? 'eng';
  return (OCR_LANGUAGES as readonly string[]).includes(language)
    ? (language as OcrLanguage)
    : undefined;
}

/** "| was here" → "I was here": what Tesseract makes of a capital I, and stray marks. */
export function cleanLine(text: string): string {
  return text
    .replace(/(^|\s)\|(?=\s|$|')/g, '$1I')
    .replace(/[|_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The recognised pictures as WebVTT; one after another with the same text become one. */
export function toVtt(cues: { start: number; end: number; text: string }[]): string {
  const merged: typeof cues = [];
  for (const cue of cues) {
    const last = merged.at(-1);
    if (last && last.text === cue.text && cue.start - last.end < 0.25) last.end = cue.end;
    else merged.push({ ...cue });
  }
  const time = (seconds: number) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
  };
  const blocks = merged.map((c) => `${time(c.start)} --> ${time(c.end)}\n${c.text}`);
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** Text recognition with tesseract.js; one reader per language, made when first needed. */
export class TesseractEngine implements OcrEngine {
  private readonly workers = new Map<OcrLanguage, Promise<import('tesseract.js').Worker>>();

  constructor(private readonly cacheDir: string) {}

  private worker(language: OcrLanguage) {
    let worker = this.workers.get(language);
    if (!worker) {
      worker = (async () => {
        const { createWorker } = await import('tesseract.js');
        // The language data ships as npm packages: no download at run time.
        const data = require(`@tesseract.js-data/${language}`) as { langPath: string };
        const cachePath = path.join(this.cacheDir, 'ocr');
        await mkdir(cachePath, { recursive: true });
        const created = await createWorker(language, 1, {
          langPath: data.langPath,
          gzip: true,
          cachePath,
          logger: () => {},
          errorHandler: () => {},
        });
        // One block of text: a subtitle of one or two lines.
        await created.setParameters({ tessedit_pageseg_mode: '6' as never });
        return created;
      })();
      this.workers.set(language, worker);
    }
    return worker;
  }

  async read(picture: PgsPicture, language: OcrLanguage): Promise<string> {
    const header = Buffer.from(`P5\n${picture.width} ${picture.height}\n255\n`);
    const worker = await this.worker(language);
    const { data } = await worker.recognize(Buffer.concat([header, picture.data]));
    return data.text;
  }

  async close(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map(async (w) => (await w).terminate().catch(() => {})));
  }
}

interface Job {
  fileId: string;
  streamIndex: number;
}

export class PgsOcr {
  private readonly options: PgsOcrOptions;
  private readonly states = new Map<string, { state: OcrState; progress?: number }>();
  private readonly queue: Job[] = [];
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: PgsOcrOptions) {
    this.options = options;
  }

  private key(fileId: string, streamIndex: number) {
    return `${fileId}:${streamIndex}`;
  }

  private failedMarker(fileId: string, streamIndex: number) {
    return path.join(this.options.cacheDir, 'subtitles', 'ocr-failed', `${fileId}-${streamIndex}`);
  }

  /** What happens with a track now (undefined: nothing yet, or it is done). */
  async state(
    fileId: string,
    streamIndex: number,
  ): Promise<{ state: OcrState; progress?: number } | undefined> {
    const known = this.states.get(this.key(fileId, streamIndex));
    if (known) return known;
    return (await exists(this.failedMarker(fileId, streamIndex))) ? { state: 'failed' } : undefined;
  }

  /** Someone picked this track: first in line. */
  request(fileId: string, streamIndex: number): { state: OcrState; progress?: number } {
    const key = this.key(fileId, streamIndex);
    const known = this.states.get(key);
    if (known && known.state !== 'failed') return known;
    this.queue.unshift({ fileId, streamIndex });
    const state = { state: 'queued' as const };
    this.states.set(key, state);
    void this.drain();
    return state;
  }

  /** Works through the queue, one track at a time. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        await this.convert(job);
      }
    } finally {
      this.running = false;
    }
  }

  /** In the background, while nobody watches: the next track worth reading. */
  async runOnce(): Promise<boolean> {
    if (this.running || (this.options.idle && !this.options.idle())) return false;
    const next = await this.nextTrack();
    if (!next) return false;
    this.queue.push(next);
    this.states.set(this.key(next.fileId, next.streamIndex), { state: 'queued' });
    await this.drain();
    return true;
  }

  private async nextTrack(): Promise<Job | undefined> {
    const files = await this.options.prisma.mediaFile.findMany({
      select: {
        id: true,
        subtitleTracks: true,
        subtitles: {
          where: { source: 'EMBEDDED', path: { not: null } },
          select: { externalId: true },
        },
      },
      orderBy: [{ addedAt: 'desc' }, { path: 'asc' }],
    });
    for (const file of files) {
      const tracks = (Array.isArray(file.subtitleTracks)
        ? file.subtitleTracks
        : []) as unknown as SubtitleTrack[];
      // A language the file has as text already doesn't need reading.
      const asText = new Set(
        tracks.filter((t) => t.textBased).map((t) => languageCode(t.language) ?? 'und'),
      );
      const done = new Set(file.subtitles.map((s) => s.externalId));
      for (const track of tracks) {
        const language = ocrLanguage(track);
        if (!language || asText.has(language) || track.forced) continue;
        if (done.has(String(track.index))) continue;
        if (this.states.has(this.key(file.id, track.index))) continue;
        if (await exists(this.failedMarker(file.id, track.index))) continue;
        return { fileId: file.id, streamIndex: track.index };
      }
    }
    return undefined;
  }

  private async convert(job: Job): Promise<void> {
    const key = this.key(job.fileId, job.streamIndex);
    const state: { state: OcrState; progress?: number } = { state: 'running', progress: 0 };
    this.states.set(key, state);
    const started = Date.now();
    try {
      const file = await this.options.prisma.mediaFile.findUnique({
        where: { id: job.fileId },
        select: { path: true, subtitleTracks: true },
      });
      const track = ((file?.subtitleTracks ?? []) as unknown as SubtitleTrack[]).find(
        (t) => t.index === job.streamIndex,
      );
      const language = track && ocrLanguage(track);
      if (!file || !track || !language) throw new Error('no PGS track to read');
      const sup = await this.extract(file.path, job.streamIndex);
      const pictures = readPgs(sup);
      if (pictures.length === 0) throw new Error('the track has no pictures');
      const cues: { start: number; end: number; text: string }[] = [];
      for (const [n, picture] of pictures.entries()) {
        const lines = (await this.options.engine.read(picture, language))
          .split('\n')
          .map(cleanLine)
          .filter((line) => /\p{L}/u.test(line));
        if (lines.length > 0)
          cues.push({ start: picture.start, end: picture.end, text: lines.join('\n') });
        state.progress = (n + 1) / pictures.length;
      }
      if (cues.length === 0) throw new Error('no text recognised');
      await this.options.store(job.fileId, job.streamIndex, toVtt(cues));
      this.states.delete(key);
      this.options.log?.info(
        {
          fileId: job.fileId,
          streamIndex: job.streamIndex,
          lines: cues.length,
          seconds: Math.round((Date.now() - started) / 1000),
        },
        'subtitles: picture track read as text',
      );
    } catch (error) {
      this.states.set(key, { state: 'failed' });
      const marker = this.failedMarker(job.fileId, job.streamIndex);
      await mkdir(path.dirname(marker), { recursive: true }).catch(() => {});
      await writeFile(marker, error instanceof Error ? error.message : String(error)).catch(
        () => {},
      );
      this.options.log?.warn(
        { err: error, fileId: job.fileId },
        'subtitles: could not read a picture track',
      );
    }
  }

  /** The track as a .sup, copied out of the file by FFmpeg. */
  private extract(relPath: string, streamIndex: number): Promise<Uint8Array> {
    const input = path.join(this.options.mediaRoot, ...relPath.split('/'));
    // prettier-ignore
    const args = [
      '-hide_banner', '-nostats', '-loglevel', 'error',
      '-i', input, '-map', `0:${streamIndex}`, '-c', 'copy', '-f', 'sup', '-',
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.ffmpeg ?? 'ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => child.kill(), EXTRACT_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0)
          reject(new Error(`ffmpeg: ${stderr.trim().split('\n').at(-1) ?? `exit ${code}`}`));
        else resolve(Buffer.concat(chunks));
      });
    });
  }

  /** Every minute; one track per pass, while nobody watches. */
  start(intervalMs = 60_000): void {
    const tick = () => {
      this.runOnce().catch((error: unknown) =>
        this.options.log?.warn({ err: error }, 'subtitles: a reading pass failed'),
      );
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.options.engine.close();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
