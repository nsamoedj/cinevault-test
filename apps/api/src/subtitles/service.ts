// SubtitleService: everything a player can show for a file, as WebVTT.
//
// - Embedded text tracks are read by the native transcoder while playing
//   (see apps/transcoder/src/subtitles.ts). A track read completely from the
//   start is kept in CACHE_DIR, so next time it is there at once.
// - Sidecar files next to the video (found by the scanner) are converted on
//   request; they stay where they are, read only.
// - Downloads from a provider (OpenSubtitles) are converted once and kept.
// - Picture subtitles (PGS) are read as text by PgsOcr (ocr.ts), in the
//   background or when someone picks one, and kept like an embedded track.
// VobSub can't become text and is listed as such.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  languageCode,
  type SubtitleExtraction,
  type SubtitleOption,
  type SubtitleSearchResult,
  type SubtitleTrack,
  subtitleFormat,
  toWebVtt,
} from '@cinevault/shared';
import type { PrismaClient, Subtitle } from '../generated/prisma/client.js';
import type { TranscoderClient } from '../transcoder.js';
import { decodeSubtitle } from './decode.js';
import { movieHash } from './moviehash.js';
import { type OcrEngine, ocrLanguage, PgsOcr } from './ocr.js';
import type { SubtitleProvider, SubtitleQuery } from './types.js';
import { SubtitleProviderError } from './types.js';

export interface SubtitleServiceOptions {
  prisma: PrismaClient;
  mediaRoot: string;
  cacheDir: string;
  transcoder?: TranscoderClient;
  opensubtitles?: SubtitleProvider;
  /** Reads picture subtitles (PGS) as text; without it they stay unsupported. */
  ocr?: { engine: OcrEngine; ffmpeg?: string; idle?: () => boolean; log?: PgsLog };
  /** How often a whole track being read for a TV is looked at (tests: shorter). */
  wholePollMs?: number;
}

type PgsLog = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

const EMBEDDED = 'embedded:';

/** A request that can't be served, with the HTTP status to answer with. */
export class SubtitleError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface ExtractionJob {
  fileId: string;
  streamIndex: number;
  start: number;
}

/** An embedded track read from start to end for a Chromecast (prepare). */
interface WholeRead {
  /** 0-1, from how far FFmpeg got in the file. */
  progress: number;
  error?: string;
  at: number;
}

/** After a failure, a new prepare tries again after this long. */
const WHOLE_RETRY_MS = 30_000;
/** A whole read that takes longer than this is given up. */
const WHOLE_MAX_MS = 30 * 60_000;

export class SubtitleService {
  private readonly options: SubtitleServiceOptions;
  /** Running extractions, to keep a track that was read completely. */
  private readonly jobs = new Map<string, ExtractionJob>();
  /** Embedded tracks read whole for a TV, by "<fileId>:<stream index>". */
  private readonly whole = new Map<string, WholeRead>();
  /** Recent search results by id: language and release name for a download. */
  private readonly found = new Map<string, SubtitleSearchResult>();

  /** Picture subtitles as text (ocr.ts). */
  readonly ocr: PgsOcr | undefined;

  constructor(options: SubtitleServiceOptions) {
    this.options = options;
    this.ocr = options.ocr
      ? new PgsOcr({
          prisma: options.prisma,
          mediaRoot: options.mediaRoot,
          cacheDir: options.cacheDir,
          engine: options.ocr.engine,
          store: (fileId, streamIndex, vtt) => this.storeEmbedded(fileId, streamIndex, vtt),
          ...(options.ocr.ffmpeg && { ffmpeg: options.ocr.ffmpeg }),
          ...(options.ocr.idle && { idle: options.ocr.idle }),
          ...(options.ocr.log && { log: options.ocr.log }),
        })
      : undefined;
  }

  get canSearch(): boolean {
    return Boolean(this.options.opensubtitles);
  }

  private async file(fileId: string) {
    const file = await this.options.prisma.mediaFile.findUnique({
      where: { id: fileId },
      include: {
        subtitles: true,
        mediaItem: true,
        episode: { include: { season: { include: { mediaItem: true } } } },
      },
    });
    if (!file) throw new SubtitleError(404, 'file not found');
    return file;
  }

  private toOption(row: Subtitle): SubtitleOption {
    const source = row.source === 'OPENSUBTITLES' ? 'opensubtitles' : 'external';
    return {
      id: row.id,
      source,
      ...(row.language !== 'und' && { language: row.language }),
      ...(row.label && { label: row.label }),
      forced: row.forced,
      hearingImpaired: row.hearingImpaired,
      offsetMs: row.offsetMs,
      supported: true,
      url: `/api/subtitles/${row.id}/vtt`,
    };
  }

  async list(fileId: string): Promise<SubtitleOption[]> {
    const file = await this.file(fileId);
    const tracks = file.subtitleTracks as unknown as SubtitleTrack[];
    const embedded: SubtitleOption[] = [];
    for (const track of tracks) {
      const row = file.subtitles.find(
        (s) => s.source === 'EMBEDDED' && s.externalId === String(track.index),
      );
      const language = languageCode(track.language) ?? track.language;
      // A picture track read as text: a text subtitle now.
      const read = !track.textBased && Boolean(row?.path);
      const ocr = !track.textBased && this.ocr && ocrLanguage(track) ? this.ocr : undefined;
      const reading = ocr && !read ? await ocr.state(fileId, track.index) : undefined;
      embedded.push({
        id: `${EMBEDDED}${track.index}`,
        source: 'embedded',
        ...(language && language !== 'und' && { language }),
        ...(track.title && { label: track.title }),
        codec: track.codec,
        forced: track.forced,
        hearingImpaired: /\b(sdh|cc|hearing)\b/i.test(track.title ?? ''),
        offsetMs: row?.offsetMs ?? 0,
        supported: track.textBased || read,
        ...((track.textBased || read) && row?.path && { url: `/api/subtitles/${row.id}/vtt` }),
        // A track to read (text), or a picture track that can be read as text.
        ...(((track.textBased && !row?.path) || (ocr && !read)) && { streamIndex: track.index }),
        ...(read && { ocr: 'done' as const }),
        ...(ocr && !read && { ocr: reading?.state ?? ('possible' as const) }),
        ...(reading?.progress !== undefined && { ocrProgress: reading.progress }),
      });
    }
    const order = { EXTERNAL: 0, OPENSUBTITLES: 1, EMBEDDED: 2, WHISPER: 3 };
    const stored = file.subtitles
      .filter((s) => s.source !== 'EMBEDDED')
      .sort(
        (a, b) =>
          order[a.source] - order[b.source] || a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((row) => this.toOption(row));
    return [...embedded, ...stored];
  }

  /** The whole subtitle as WebVTT. */
  async vtt(subtitleId: string): Promise<string> {
    const row = await this.options.prisma.subtitle.findUnique({ where: { id: subtitleId } });
    if (!row?.path) throw new SubtitleError(404, 'subtitle not found');
    if (row.path.startsWith('media:')) {
      const relPath = row.path.slice('media:'.length);
      const format = subtitleFormat(relPath);
      const absolute = path.join(this.options.mediaRoot, ...relPath.split('/'));
      const bytes = await readFile(absolute).catch(() => undefined);
      if (!format || !bytes) throw new SubtitleError(404, 'subtitle file not found');
      return toWebVtt(decodeSubtitle(bytes), format);
    }
    const text = await readFile(this.cachePath(row.path), 'utf8').catch(() => undefined);
    if (text === undefined) throw new SubtitleError(404, 'cached subtitle missing');
    return text;
  }

  private cachePath(relative: string): string {
    const root = path.resolve(this.options.cacheDir);
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new SubtitleError(400, 'bad cache path');
    return absolute;
  }

  private async save(relative: string, vtt: string): Promise<void> {
    const absolute = this.cachePath(relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, vtt);
  }

  async setOffset(fileId: string, subtitleId: string, offsetMs: number): Promise<SubtitleOption> {
    const { prisma } = this.options;
    if (subtitleId.startsWith(EMBEDDED)) {
      const streamIndex = Number(subtitleId.slice(EMBEDDED.length));
      const file = await this.file(fileId);
      const track = (file.subtitleTracks as unknown as SubtitleTrack[]).find(
        (t) => t.index === streamIndex,
      );
      if (!track) throw new SubtitleError(404, 'no such subtitle track');
      await prisma.subtitle.upsert({
        where: {
          mediaFileId_source_externalId: {
            mediaFileId: fileId,
            source: 'EMBEDDED',
            externalId: String(streamIndex),
          },
        },
        create: {
          mediaFileId: fileId,
          source: 'EMBEDDED',
          externalId: String(streamIndex),
          streamIndex,
          language: languageCode(track.language) ?? 'und',
          offsetMs,
        },
        update: { offsetMs },
      });
    } else {
      const row = await prisma.subtitle.findFirst({
        where: { id: subtitleId, mediaFileId: fileId },
      });
      if (!row) throw new SubtitleError(404, 'subtitle not found');
      await prisma.subtitle.update({ where: { id: row.id }, data: { offsetMs } });
    }
    const option = (await this.list(fileId)).find((o) => o.id === subtitleId);
    if (!option) throw new SubtitleError(404, 'subtitle not found');
    return option;
  }

  async extract(fileId: string, streamIndex: number, start: number): Promise<SubtitleExtraction> {
    const { transcoder } = this.options;
    if (!transcoder) {
      throw new SubtitleError(503, 'no transcoder configured (TRANSCODER_TOKEN is not set)');
    }
    const file = await this.file(fileId);
    const track = (file.subtitleTracks as unknown as SubtitleTrack[]).find(
      (t) => t.index === streamIndex,
    );
    if (!track) throw new SubtitleError(404, 'no such subtitle track');
    if (!track.textBased) {
      throw new SubtitleError(422, 'image subtitles (PGS, VobSub) cannot be shown as text');
    }
    const job = await transcoder.createSubtitleJob({ path: file.path, streamIndex, start });
    this.jobs.set(job.id, { fileId, streamIndex, start: job.start });
    return { id: job.id, start: job.start };
  }

  async extracted(jobId: string): Promise<{ vtt: string; covered: number; complete: boolean }> {
    const { transcoder } = this.options;
    if (!transcoder) throw new SubtitleError(503, 'no transcoder configured');
    const result = await transcoder.subtitleText(jobId);
    const job = this.jobs.get(jobId);
    // Read from the very start to the end: that is the whole track. Keep it.
    if (result.complete && job) {
      this.jobs.delete(jobId);
      if (job.start === 0) await this.storeEmbedded(job.fileId, job.streamIndex, result.vtt);
    }
    return result;
  }

  /** The whole text of an embedded track (read from the file, or read from its pictures), kept. */
  async storeEmbedded(fileId: string, streamIndex: number, vtt: string): Promise<void> {
    const relative = `subtitles/embedded/${fileId}-${streamIndex}.vtt`;
    await this.save(relative, vtt);
    const file = await this.file(fileId);
    const track = (file.subtitleTracks as unknown as SubtitleTrack[]).find(
      (t) => t.index === streamIndex,
    );
    await this.options.prisma.subtitle.upsert({
      where: {
        mediaFileId_source_externalId: {
          mediaFileId: fileId,
          source: 'EMBEDDED',
          externalId: String(streamIndex),
        },
      },
      create: {
        mediaFileId: fileId,
        source: 'EMBEDDED',
        externalId: String(streamIndex),
        streamIndex,
        language: languageCode(track?.language) ?? 'und',
        path: relative,
      },
      update: { path: relative },
    });
  }

  /**
   * A subtitle for a Chromecast: the receiver loads one whole WebVTT file
   * (SubtitleOption.url), it can't follow a track being read while it plays.
   * An embedded text track is read from start to end now (in the background,
   * kept like a track read from 0), a picture track is read as text. Asked
   * again until the answer has a `url`; `readProgress` says how far it is.
   */
  async prepare(fileId: string, subtitleId: string): Promise<SubtitleOption> {
    const option = (await this.list(fileId)).find((o) => o.id === subtitleId);
    if (!option) throw new SubtitleError(404, 'subtitle not found');
    if (option.url || option.streamIndex === undefined) {
      if (!option.url) throw new SubtitleError(422, 'this subtitle cannot be shown as text');
      return option;
    }
    if (option.ocr) {
      if (option.ocr === 'possible' || option.ocr === 'failed') {
        return this.readPictures(fileId, option.streamIndex);
      }
      return option;
    }
    const key = `${fileId}:${option.streamIndex}`;
    const read = this.whole.get(key);
    if (read?.error) {
      if (Date.now() - read.at < WHOLE_RETRY_MS) {
        throw new SubtitleError(502, `reading the subtitle failed: ${read.error}`);
      }
      this.whole.delete(key);
    }
    if (!this.whole.has(key)) this.readWhole(fileId, option.streamIndex, key);
    const progress = this.whole.get(key)?.progress ?? 0;
    return { ...option, readProgress: progress };
  }

  private readWhole(fileId: string, streamIndex: number, key: string): void {
    const state: WholeRead = { progress: 0, at: Date.now() };
    this.whole.set(key, state);
    const pause = this.options.wholePollMs ?? 2_000;
    void (async () => {
      try {
        const file = await this.file(fileId);
        const duration = (file.durationMs ?? 0) / 1000;
        const job = await this.extract(fileId, streamIndex, 0);
        try {
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, pause));
            // Kept as the whole track by extracted() once complete.
            const result = await this.extracted(job.id);
            if (result.complete) break;
            if (duration > 0) state.progress = Math.min(0.99, result.covered / duration);
            if (Date.now() - state.at > WHOLE_MAX_MS) {
              throw new SubtitleError(504, 'reading the subtitle took too long');
            }
          }
        } catch (error) {
          await this.stopExtraction(job.id).catch(() => {});
          throw error;
        }
        this.whole.delete(key);
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        state.at = Date.now();
      }
    })();
  }

  /** Someone picked a picture subtitle: read it as text now (first in line). */
  async readPictures(fileId: string, streamIndex: number): Promise<SubtitleOption> {
    if (!this.ocr) throw new SubtitleError(503, 'reading picture subtitles is off');
    const file = await this.file(fileId);
    const track = (file.subtitleTracks as unknown as SubtitleTrack[]).find(
      (t) => t.index === streamIndex,
    );
    if (!track) throw new SubtitleError(404, 'no such subtitle track');
    if (!ocrLanguage(track)) {
      throw new SubtitleError(422, 'only PGS subtitles in English or Dutch can be read as text');
    }
    const done = file.subtitles.some(
      (s) => s.source === 'EMBEDDED' && s.externalId === String(streamIndex) && s.path,
    );
    if (!done) this.ocr.request(fileId, streamIndex);
    const option = (await this.list(fileId)).find((o) => o.id === `${EMBEDDED}${streamIndex}`);
    if (!option) throw new SubtitleError(404, 'no such subtitle track');
    return option;
  }

  async stopExtraction(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    await this.options.transcoder?.stopSubtitleJob(jobId);
  }

  private provider(): SubtitleProvider {
    if (!this.options.opensubtitles) {
      throw new SubtitleError(503, 'OpenSubtitles is not configured (OPENSUBTITLES_API_KEY)');
    }
    return this.options.opensubtitles;
  }

  async search(fileId: string, languages: string[]): Promise<SubtitleSearchResult[]> {
    const provider = this.provider();
    const file = await this.file(fileId);
    const show = file.episode?.season.mediaItem;
    const movie = file.mediaItem;
    const moviehash = await movieHash(
      path.join(this.options.mediaRoot, ...file.path.split('/')),
    ).catch(() => undefined);
    const query: SubtitleQuery =
      file.episode && show
        ? {
            kind: 'episode',
            title: show.title,
            ...(show.tmdbId && { showTmdbId: show.tmdbId }),
            ...(show.imdbId && { showImdbId: show.imdbId }),
            season: file.episode.season.seasonNumber,
            episode: file.episode.episodeNumber,
            languages,
            ...(moviehash && { moviehash }),
          }
        : {
            kind: 'movie',
            title: movie?.title ?? path.basename(file.path),
            ...(movie?.year && { year: movie.year }),
            ...(movie?.tmdbId && { tmdbId: movie.tmdbId }),
            ...(movie?.imdbId && { imdbId: movie.imdbId }),
            languages,
            ...(moviehash && { moviehash }),
          };
    const results = await provider.search(query);
    for (const result of results) this.found.set(result.id, result);
    while (this.found.size > 1000) this.found.delete(this.found.keys().next().value as string);
    return results;
  }

  async download(fileId: string, resultId: string): Promise<SubtitleOption> {
    const hint = this.found.get(resultId);
    const { prisma } = this.options;
    const existing = await prisma.subtitle.findUnique({
      where: {
        mediaFileId_source_externalId: {
          mediaFileId: fileId,
          source: 'OPENSUBTITLES',
          externalId: resultId,
        },
      },
    });
    if (existing) return this.toOption(existing);
    await this.file(fileId);

    const { bytes, fileName } = await this.provider().download(resultId);
    const format = subtitleFormat(fileName) ?? 'srt';
    const vtt = toWebVtt(decodeSubtitle(bytes), format);
    if (!vtt.includes('-->'))
      throw new SubtitleProviderError(502, 'the downloaded subtitle has no cues');
    const id = randomUUID();
    const relative = `subtitles/opensubtitles/${id}.vtt`;
    await this.save(relative, vtt);
    const language = hint?.language ?? languageCode(/\.([a-z]{2,3})\.[a-z]+$/i.exec(fileName)?.[1]);
    const row = await prisma.subtitle.create({
      data: {
        id,
        mediaFileId: fileId,
        source: 'OPENSUBTITLES',
        externalId: resultId,
        language: language ?? 'und',
        label: hint?.release ?? fileName.replace(/\.[a-z]+$/i, ''),
        hearingImpaired: hint?.hearingImpaired ?? false,
        path: relative,
      },
    });
    return this.toOption(row);
  }

  async remove(subtitleId: string): Promise<void> {
    const { prisma } = this.options;
    const row = await prisma.subtitle.findUnique({ where: { id: subtitleId } });
    if (!row) throw new SubtitleError(404, 'subtitle not found');
    if (row.source !== 'OPENSUBTITLES') {
      throw new SubtitleError(400, 'only downloaded subtitles can be removed');
    }
    await prisma.subtitle.delete({ where: { id: row.id } });
    if (row.path) await rm(this.cachePath(row.path), { force: true });
  }
}
