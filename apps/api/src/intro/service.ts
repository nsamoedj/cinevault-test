// Skip Intro, the end credits and the recap: finds each episode's intro,
// credits and "Previously on…" in the background and keeps them on the file
// (MediaFile.intro*, credits*, recap*).
//
// Per episode: for anime, the times on AniSkip (aniskip.ts), which needs no
// disk reads; else a chapter called "Intro" or "Opening" ("Credits", "Ending")
// if the file has one; otherwise the part of the audio it shares with the
// episodes next to it (match.ts), from the transcoder's fingerprints of the
// first minutes (the last minutes). The recap: a chapter "Recap" or
// "Previously", else the clips of the episode before that this one plays near
// its start. Fingerprints are kept in CACHE_DIR/intro per file version, so a
// new episode only needs its own.
//
// Films have only end credits, found in the picture (film.ts): the
// transcoder measures keyframes in the last part, and a scene after the
// credits ends them there, so it is never skipped.
//
// The work reads a lot from the media disks, so it runs while nobody is
// watching, the newest episodes and films first. An episode that is opened goes first,
// with its season, at a gentler read rate.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AudioTrack,
  type IntroInfo,
  type IntroStatus,
  MARKER_KINDS,
  type MarkerKind,
  MIN_MARKER_CONFIDENCE,
  type SeasonMarkers,
} from '@cinevault/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { HttpError } from '../metadata/http.js';
import { type TranscoderClient, TranscoderError } from '../transcoder.js';
import type { AniSkip, SkipTimes } from './aniskip.js';
import {
  EXTEND_SECONDS,
  type FrameSample,
  filmCredits,
  frameKind,
  type Range,
  sampleTimes,
  STEP_SECONDS,
  windowStart,
} from './film.js';
import {
  type Chapter,
  CREDITS_LIMITS,
  creditsChapter,
  decodeFrames,
  introChapter,
  MAX_INTRO_SECONDS,
  MIN_INTRO_SECONDS,
  pickPreview,
  pickShared,
  previewChapter,
  type RecapClip,
  recapChapter,
  scoreRecap,
  type Segment,
  sharedClips,
  sharedConfidence,
  sharedSegments,
} from './match.js';

type Part = 'intro' | 'credits' | 'recap' | 'preview';
/** The fingerprints: of the start of a file (intro, recap) or of its end (credits). */
type Window = 'intro' | 'credits';
type Source = 'chapter' | 'aniskip' | 'audio' | 'picture';
/**
 * What a search found: the part, how sure it is (0-1), and (credits from the
 * picture) the parts after a scene.
 */
type Found = { range?: Range; source?: Source; confidence?: number; more?: Range[] };

/** How sure a part is by where it came from (the audio has its own measure). */
const CONFIDENCE = {
  chapter: 0.95,
  aniskip: 0.9,
  /** A film's credits: the picture is all there is, and a scene after them stops them. */
  filmPicture: 0.7,
  /** An episode's credits from the picture only: no other episode agrees. */
  picture: 0.5,
};

/**
 * How much of each episode: for the intro the first 45%, at most 10 minutes
 * (cold opens can be long); for the credits the last 40%, at most 10 minutes
 * (a closing scene, the credits, a preview of the next episode; the credits
 * of a Marvel show run 7 to 9 minutes).
 */
const WINDOW: Record<Window, { max: number; share: number }> = {
  intro: { max: 600, share: 0.45 },
  credits: { max: 600, share: 0.4 },
};
/**
 * The transcoder's step between fingerprint frames (apps/transcoder/src/fingerprint.ts).
 * Fingerprints with another step (0.124 s, before 2026-10-28) are read again:
 * two episodes are only compared at the same step.
 */
const FINGERPRINT_HOP = 341 / 11025;
const LIMITS: Record<Window, { min: number; max: number }> = {
  intro: { min: MIN_INTRO_SECONDS, max: MAX_INTRO_SECONDS },
  credits: CREDITS_LIMITS,
};
/** A recap is in the first minutes: clips of the episode before are looked for this far. */
const RECAP_REGION_SECONDS = 360;
/** Episodes a recap may show: the one before (all of it), and the start and end of the two before that. */
const RECAP_EPISODES = 3;
/**
 * Older episodes a recap may show too (a story that goes back further, the
 * season before for a premiere): only what is in the cache already, the
 * parts read for their own intro, credits and recaps, so nothing more is
 * read from the disks.
 */
const RECAP_CACHED_EPISODES = 12;
/** Episodes shorter than this get no intro search (shorts, trailers). */
const MIN_DURATION_MS = 4 * 60_000;
/** Films shorter than this get no credits search (shorts, extras). */
const MIN_FILM_DURATION_MS = 20 * 60_000;
/** Keyframes measured per request to the transcoder, and the time each may take. */
const FRAMES_PER_REQUEST = 40;
const FRAME_TIMEOUT_MS = 3_000;
/** A film being watched (opened): a pause between requests, so its stream keeps the disk. */
const PRIORITY_FRAMES_PAUSE_MS = 5_000;
/** Other episodes to compare with; the search stops after this many matches. */
const NEIGHBOURS = 4;
const ENOUGH = 3;
/** The background search waits this long after the last stream request. */
const IDLE_MS = 2 * 60_000;
const TICK_MS = 30_000;
/**
 * Disk read targets for the transcoder, in bits per second of file: while
 * someone watches, some room for the stream; while nobody does, as fast as
 * the disk goes (FFmpeg's -readrate up to IDLE_READRATE times real time).
 */
const BACKGROUND_READ = 960_000_000;
const PRIORITY_READ = 320_000_000;
const IDLE_READ = 8_000_000_000;
const READRATE = 100;
const IDLE_READRATE = 200;
/** For the timeout of a read the disk sets the pace: this many bytes per second at least. */
const DISK_BYTES_PER_SECOND = 60_000_000;
/** FFmpeg runs at once for a film's keyframes: several while nobody watches. */
const IDLE_FRAME_JOBS = 3;
/** A film's window is first measured at every this many keyframe times. */
const COARSE_EVERY = 3;
/**
 * A recap shows the middle of the episode before too, so all of it is read.
 * Once this many episodes of a season (not its first) were looked at and
 * none had a recap, the next ones compare with its start and end only.
 */
const NO_RECAP_SEASON = 3;
/**
 * One read takes at most this long (a faster read rate for a long piece or a
 * high bitrate), and the transcoder gets at most FINGERPRINT_TIMEOUT_MS: Node's
 * fetch gives up at 5 minutes, and the transcoder then read on for nothing.
 */
const MAX_READ_SECONDS = 150;
const FINGERPRINT_TIMEOUT_MS = 280_000;
/**
 * A transcoder that reports how far it read is waited for while it reads on:
 * given up after this long without anything new, or this long in all. (A
 * 10-minute window of a 4K remux is 3-4 GB; on a busy disk minutes.)
 */
const FINGERPRINT_STALL_MS = 120_000;
const FINGERPRINT_MAX_MS = 30 * 60_000;
/** "Alles nu zoeken" stops when the transcoder didn't answer this many times in a row. */
const RUSH_TRANSCODER_TRIES = 10;
/**
 * AniSkip gets new times as people watch: an episode it didn't know (or that
 * only the audio found) is asked again after a few days, while it is recent.
 */
const ANISKIP_RECHECK_MS = 3 * 24 * 60 * 60 * 1000;
const ANISKIP_RECENT_MS = 60 * 24 * 60 * 60 * 1000;
const ANISKIP_BATCH = 25;
/** AniSkip or the anime-lists can't be reached: leave them alone this long. */
const ANISKIP_PAUSE_MS = 15 * 60_000;

interface Logger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface IntroServiceOptions {
  prisma: PrismaClient;
  transcoder?: TranscoderClient;
  /** CACHE_DIR; fingerprints are not kept without it. */
  cacheDir?: string;
  /** AniSkip for anime; without it only chapters and the audio. */
  aniskip?: AniSkip;
  log?: Logger;
  now?: () => number;
  /** Between requests for an opened film (tests: 0). */
  filmPauseMs?: number;
}

/** When someone last streamed: the search keeps off the disks while people watch. */
export class Activity {
  private last = -Infinity;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  touch() {
    this.last = this.now();
  }

  idle(ms: number): boolean {
    return this.now() - this.last >= ms;
  }
}

/**
 * A problem with this file (the transcoder could not read it: 404, 408,
 * 422): it is marked as looked at, until it changes. Anything else (the
 * transcoder away, a bug) must not mark it: then nothing would ever be
 * found for it.
 */
function fileProblem(error: unknown): boolean {
  return error instanceof TranscoderError && error.statusCode < 500;
}

/** Files that failed this often with an unexpected error are left alone until a restart. */
const MAX_FAILURES = 3;

interface FileRow {
  id: string;
  path: string;
  size: bigint;
  modifiedAt: Date;
  durationMs: number | null;
  bitrate: number | null;
  audioTracks: unknown;
}

interface Print {
  hop: number;
  frames: Uint32Array;
  chapters: Chapter[];
  /** Where the frames begin in the file, in seconds. */
  start: number;
}

const fileSelect = {
  id: true,
  path: true,
  size: true,
  modifiedAt: true,
  durationMs: true,
  bitrate: true,
  audioTracks: true,
} as const;

/** Episode files the search covers: regular seasons, long enough, probed. */
const searchable = {
  episode: { season: { seasonNumber: { gt: 0 } } },
  durationMs: { gte: MIN_DURATION_MS },
  probeError: null,
} as const;

/** Still to do: the intro, the credits, the recap or the preview not looked for yet. */
const open = {
  OR: [
    { introCheckedAt: null },
    { creditsCheckedAt: null },
    { recapCheckedAt: null },
    { previewCheckedAt: null },
  ],
};
/**
 * First the intro and the credits of every episode (a start and an end: a
 * third of a file), then the recaps (the whole episode before): Skip Intro
 * is everywhere long before the last recap is found.
 */
const openFirst = { OR: [{ introCheckedAt: null }, { creditsCheckedAt: null }] };
const openRecap = { OR: [{ recapCheckedAt: null }, { previewCheckedAt: null }] };

/** Film files the credits search covers: long enough, probed. */
const films = {
  episodeId: null,
  mediaItem: { type: 'MOVIE' },
  durationMs: { gte: MIN_FILM_DURATION_MS },
  probeError: null,
} as const;

/** A part of a file to fingerprint; `name` sets its cache file (CACHE_DIR/intro/<id><name>.json). */
interface Span {
  name: string;
  /** From where and how much, in seconds. */
  start: number;
  seconds: number;
}

/** The start of a file (intro, recap) or its end (credits). */
function span(file: FileRow, part: Window): Span {
  const window = WINDOW[part];
  const duration = (file.durationMs ?? window.max * 1000) / 1000;
  const seconds = Math.round(Math.min(window.max, Math.max(60, duration * window.share)));
  return part === 'intro'
    ? { name: '', start: 0, seconds }
    : { name: '.end', start: Math.max(0, Math.floor(duration - seconds)), seconds };
}

/** The transcoder takes at most 30 minutes at a time: the middle in pieces. */
const MIDDLE_PIECE_SECONDS = 1500;

/** What is between the start and the end window, so a whole episode is covered (the recap of the next). */
function middleSpans(file: FileRow): Span[] {
  const from = span(file, 'intro').seconds;
  const to = span(file, 'credits').start;
  const spans: Span[] = [];
  for (let start = from, k = 0; to - start >= 5; start += MIDDLE_PIECE_SECONDS, k++) {
    spans.push({
      name: `.mid${k}`,
      start,
      seconds: Math.min(MIDDLE_PIECE_SECONDS, to - start),
    });
  }
  return spans;
}

export class IntroService {
  readonly activity: Activity;
  private readonly options: IntroServiceOptions;
  private readonly priority: string[] = [];
  /**
   * Files a scan just brought in (Sonarr/Radarr, the hourly scan): looked at
   * right after the opened ones, also while someone watches (at the gentle
   * read rate then), so a new episode has its Skip Intro before it is played.
   */
  private readonly fresh: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  /** Only after start(): tests drive runOnce themselves. */
  private running = false;
  private current: { path: string; since: number } | undefined;
  private reading:
    | {
        path: string;
        part: 'start' | 'middle' | 'end';
        since: number;
        /** Of `seconds` of audio, read so far (a transcoder that reports it). */
        read?: number;
        seconds?: number;
      }
    | undefined;
  private waiting: IntroStatus['waiting'];
  /**
   * "Alles nu zoeken" (scripts\intro-search.ps1, Beheer): one episode after
   * the other, also while people watch, until nothing is left to look at.
   */
  private rush = false;
  private lastRushed: string | undefined;
  private rushFailures = 0;
  private rushStopped: IntroStatus['rushStopped'];
  private aniskipPausedUntil = 0;
  /** Unexpected errors per file (a bug, not the file): skipped after MAX_FAILURES. */
  private readonly failures = new Map<string, number>();

  constructor(options: IntroServiceOptions) {
    this.options = options;
    this.activity = new Activity(options.now);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Starts the background search (not in tests that drive `runOnce`). */
  start() {
    this.running = true;
    this.schedule(TICK_MS);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runOnce().then((worked) =>
        this.schedule(worked ? (this.rush ? 0 : 1_000) : TICK_MS),
      );
    }, ms);
    this.timer.unref?.();
  }

  /**
   * After a scan of a library: its files that came in or changed in it and
   * still have to be looked at go into the fresh queue, the newest first.
   * Never throws (it runs after the scan).
   */
  async scanned(scan: { libraryId: string; startedAt: Date }): Promise<number> {
    try {
      const inLibrary = {
        OR: [
          { mediaItem: { libraryId: scan.libraryId } },
          { episode: { season: { mediaItem: { libraryId: scan.libraryId } } } },
        ],
      };
      const rows = await this.options.prisma.mediaFile.findMany({
        where: {
          AND: [
            inLibrary,
            { OR: [{ createdAt: { gte: scan.startedAt } }, { probedAt: { gte: scan.startedAt } }] },
            {
              OR: [
                { ...searchable, ...openFirst },
                { ...films, creditsCheckedAt: null },
              ],
            },
          ],
        },
        orderBy: [{ addedAt: 'desc' }, { path: 'asc' }],
        select: { id: true },
        take: 200,
      });
      for (const { id } of rows) {
        if (!this.fresh.includes(id) && !this.priority.includes(id)) this.fresh.push(id);
      }
      if (rows.length > 0 && !this.busy) this.schedule(0);
      return rows.length;
    } catch (error) {
      this.options.log?.warn({ err: error }, 'intro search: could not queue the new files');
      return 0;
    }
  }

  /**
   * An episode is opened: it first, then the rest of its season that is still
   * open. Never throws: the routes call it without waiting (a database error
   * here must not end the process as an unhandled rejection).
   */
  async prioritize(fileId: string): Promise<void> {
    try {
      await this.queueSeason(fileId);
    } catch (error) {
      this.options.log?.warn({ err: error }, 'intro search: could not put a file first');
    }
  }

  private async queueSeason(fileId: string) {
    const file = await this.options.prisma.mediaFile.findUnique({
      where: { id: fileId },
      select: { episode: { select: { seasonId: true, episodeNumber: true } } },
    });
    if (!file?.episode) {
      // A film: only itself, if its credits are still to look for.
      const film = await this.options.prisma.mediaFile.findFirst({
        where: { ...films, id: fileId, creditsCheckedAt: null },
        select: { id: true },
      });
      if (!film) return;
      const index = this.priority.indexOf(fileId);
      if (index >= 0) this.priority.splice(index, 1);
      this.priority.unshift(fileId);
      if (!this.busy) this.schedule(0);
      return;
    }
    const season = await this.options.prisma.mediaFile.findMany({
      where: {
        ...searchable,
        ...open,
        episode: { seasonId: file.episode.seasonId, season: { seasonNumber: { gt: 0 } } },
      },
      select: { id: true, episode: { select: { episodeNumber: true } } },
    });
    const at = file.episode.episodeNumber;
    const order = season
      .map((f) => ({ id: f.id, n: f.episode?.episodeNumber ?? 0 }))
      // This one, then the ones after it, then the ones before.
      .sort(
        (a, b) =>
          (a.n >= at ? a.n - at : 1000 + at - a.n) - (b.n >= at ? b.n - at : 1000 + at - b.n),
      );
    for (const { id } of order.reverse()) {
      const index = this.priority.indexOf(id);
      if (index >= 0) this.priority.splice(index, 1);
      this.priority.unshift(id);
    }
    if (!this.busy) this.schedule(0);
  }

  /**
   * One file: the first with priority; else AniSkip for episodes that may have
   * times there now (no disk reads, so also while people watch); else (when
   * nobody watches) the next open one.
   */
  async runOnce(): Promise<boolean> {
    if (this.busy || (!this.options.transcoder && !this.options.aniskip)) return false;
    this.busy = true;
    try {
      let fileId = this.priority.shift();
      let urgent = fileId !== undefined;
      // Just came in: now, not when nobody watches any more; at the gentle
      // read rate while someone watches (as an opened episode), else at full speed.
      const freshTurn = !fileId && this.fresh.length > 0;
      if (freshTurn) {
        fileId = this.fresh.shift();
        urgent = !this.activity.idle(IDLE_MS);
      }
      if (!fileId && (await this.aniskipPass()) > 0) return true;
      if (!this.options.transcoder && !fileId) return false;
      if (!fileId) {
        if (!this.rush && !this.activity.idle(IDLE_MS)) {
          this.waiting = 'playback';
          return false;
        }
        // What came in last first: a new episode has its Skip Intro before it is watched.
        const newest = { orderBy: [{ addedAt: 'desc' as const }, { path: 'asc' as const }] };
        const select = { id: true, addedAt: true };
        const skip = [...this.failures].filter(([, n]) => n >= MAX_FAILURES).map(([id]) => id);
        const notFailed = skip.length > 0 ? { id: { notIn: skip } } : {};
        const [episode, film] = await Promise.all([
          this.options.prisma.mediaFile.findFirst({
            where: { ...searchable, ...openFirst, ...notFailed },
            ...newest,
            select,
          }),
          this.options.prisma.mediaFile.findFirst({
            where: { ...films, creditsCheckedAt: null, ...notFailed },
            ...newest,
            select,
          }),
        ]);
        fileId = (!film || (episode && episode.addedAt >= film.addedAt) ? episode : film)?.id;
        let round = 'first';
        if (!fileId) {
          // Then the recaps (a file comes back once for its recap).
          round = 'recap';
          fileId = (
            await this.options.prisma.mediaFile.findFirst({
              where: { ...searchable, ...openRecap, ...notFailed },
              ...newest,
              select,
            })
          )?.id;
        }
        const turn = `${round}:${fileId}`;
        // All done (or the same one again: it can't be marked): back to the quiet search.
        if (!fileId || (this.rush && turn === this.lastRushed)) {
          if (fileId && this.rush) {
            this.options.log?.warn({ fileId }, 'intro search: an episode stays open');
            this.rushStopped = 'stuck';
          }
          this.rush = false;
          this.lastRushed = undefined;
          return false;
        }
        if (this.rush) this.lastRushed = turn;
      }
      this.waiting = undefined;
      if (!fileId) return false;
      try {
        // An opened episode gets all three at once; the others (also the new
        // ones) their recap in the second round.
        await this.analyze(fileId, urgent, { recap: urgent && !freshTurn ? 'now' : 'after' });
        this.rushFailures = 0;
        return true;
      } catch (error) {
        if (error instanceof TranscoderError && error.statusCode >= 500) {
          // The transcoder is away (or busy): try again later, don't mark the file.
          this.waiting = 'transcoder';
          if (freshTurn) this.fresh.unshift(fileId);
          else if (urgent) this.priority.unshift(fileId);
          this.options.log?.warn({ err: error }, 'intro search: transcoder not available');
          if (this.rush) {
            // The same file again next time is no sign it can't be marked.
            this.lastRushed = undefined;
            if (++this.rushFailures >= RUSH_TRANSCODER_TRIES) {
              this.rush = false;
              this.rushFailures = 0;
              this.rushStopped = 'transcoder';
            }
          }
          return false;
        }
        const failures = (this.failures.get(fileId) ?? 0) + 1;
        this.failures.set(fileId, failures);
        this.options.log?.warn(
          { err: error, fileId, failures },
          failures >= MAX_FAILURES
            ? 'intro search failed: this file is left alone until a restart'
            : 'intro search failed',
        );
        return false;
      }
    } catch (error) {
      this.options.log?.warn({ err: error }, 'intro search failed');
      return false;
    } finally {
      this.current = undefined;
      this.reading = undefined;
      this.busy = false;
    }
  }

  /**
   * Looks at every episode still to do now, one after the other, without
   * waiting until nobody watches. With `all`, every episode is looked at
   * again (not what an admin set by hand); the fingerprints are cached, so
   * that is mostly comparing. Returns how many episodes are to do.
   */
  async searchAll(options: { all?: boolean } = {}): Promise<number> {
    const { prisma } = this.options;
    if (options.all) {
      await prisma.mediaFile.updateMany({
        where: { ...searchable, OR: [{ introSource: null }, { introSource: { not: 'manual' } }] },
        data: { introCheckedAt: null },
      });
      await prisma.mediaFile.updateMany({
        where: {
          ...searchable,
          OR: [{ creditsSource: null }, { creditsSource: { not: 'manual' } }],
        },
        data: { creditsCheckedAt: null },
      });
      await prisma.mediaFile.updateMany({
        where: { ...searchable, OR: [{ recapSource: null }, { recapSource: { not: 'manual' } }] },
        data: { recapCheckedAt: null },
      });
      await prisma.mediaFile.updateMany({
        where: {
          ...searchable,
          OR: [{ previewSource: null }, { previewSource: { not: 'manual' } }],
        },
        data: { previewCheckedAt: null },
      });
      await prisma.mediaFile.updateMany({
        where: { ...films, OR: [{ creditsSource: null }, { creditsSource: { not: 'manual' } }] },
        data: { creditsCheckedAt: null },
      });
    }
    const todo =
      (await prisma.mediaFile.count({ where: { ...searchable, ...open } })) +
      (await prisma.mediaFile.count({ where: { ...films, creditsCheckedAt: null } }));
    this.rush = todo > 0;
    this.rushFailures = 0;
    this.rushStopped = undefined;
    this.lastRushed = undefined;
    if (this.rush && !this.busy) this.schedule(0);
    return todo;
  }

  /** Back to searching only while nobody watches. */
  stopSearchAll(): void {
    this.rush = false;
  }

  /**
   * Looks for the intro, the credits and the recap of one episode, those not
   * looked for yet, and saves them. With `recap: 'after'` the recap waits
   * until the intro and the credits were looked for (the next round).
   */
  async analyze(
    fileId: string,
    urgent = false,
    options: { recap?: 'now' | 'after' } = {},
  ): Promise<IntroInfo> {
    const { prisma } = this.options;
    const file = await prisma.mediaFile.findUnique({
      where: { id: fileId },
      select: {
        ...fileSelect,
        hdrFormat: true,
        mediaItem: { select: { type: true } },
        createdAt: true,
        introSource: true,
        introCheckedAt: true,
        creditsSource: true,
        creditsCheckedAt: true,
        recapSource: true,
        recapCheckedAt: true,
        previewSource: true,
        previewCheckedAt: true,
        episode: {
          select: {
            episodeNumber: true,
            seasonId: true,
            season: {
              select: {
                mediaItemId: true,
                seasonNumber: true,
                mediaItem: { select: { tvdbId: true, tmdbId: true } },
              },
            },
          },
        },
      },
    });
    if (!file?.episode) {
      const film =
        file?.mediaItem?.type === 'MOVIE' &&
        (file.durationMs ?? 0) >= MIN_FILM_DURATION_MS &&
        file.creditsSource !== 'manual' &&
        file.creditsCheckedAt === null;
      if (film) await this.analyzeFilm(file, urgent);
      return this.info(fileId);
    }
    const startedAt = new Date(this.now());
    await this.reopenAround(file, file.episode);
    const parts: Part[] = [];
    if (file.introSource !== 'manual' && file.introCheckedAt === null) parts.push('intro');
    if (file.creditsSource !== 'manual' && file.creditsCheckedAt === null) parts.push('credits');
    // After the intro and the credits: the recap leaves them out.
    const recapNow = options.recap !== 'after' || parts.length === 0;
    if (recapNow && file.recapSource !== 'manual' && file.recapCheckedAt === null) {
      parts.push('recap');
    }
    // The preview after the credits: it is cut off from them.
    if (recapNow && file.previewSource !== 'manual' && file.previewCheckedAt === null) {
      parts.push('preview');
    }
    this.current = { path: file.path, since: this.now() };
    const skip = parts.length > 0 ? await this.askAniSkip(file, file.episode) : undefined;
    for (const part of parts) {
      const times = part === 'preview' ? undefined : skip?.[part];
      const found: Found = times
        ? { range: times, source: 'aniskip', confidence: CONFIDENCE.aniskip }
        : part === 'recap'
          ? await this.findRecap(file, file.episode, urgent)
          : part === 'preview'
            ? await this.findPreview(file, file.episode)
            : await this.find(file, file.episode, part, urgent);
      await this.save(file.id, part, found);
      this.options.log?.info(
        {
          file: file.path,
          [part]: found.range && {
            start: found.range.start.toFixed(1),
            end: found.range.end.toFixed(1),
          },
          source: found.source,
          confidence: found.confidence,
        },
        `${part} search`,
      );
    }
    // This one's start is in the cache now: the preview of the one before can be found.
    if (parts.includes('intro')) await this.reopenPreviewBefore(file.episode, startedAt);
    return this.info(fileId);
  }

  /**
   * The episode before gets another look for its preview, now that this
   * one's start is in the cache: if it was looked at before this one was.
   */
  private async reopenPreviewBefore(
    episode: { episodeNumber: number; season: { mediaItemId: string; seasonNumber: number } },
    since: Date,
  ) {
    const [before] = await this.previous(episode, 1);
    if (!before) return;
    await this.options.prisma.mediaFile.updateMany({
      where: { id: before.id, previewSource: null, previewCheckedAt: { lt: since } },
      data: { previewCheckedAt: null },
    });
  }

  /**
   * A film's end credits, from the picture: the last part of it, and further
   * back when the credits already run at its start. The first part is the
   * credits; parts after a scene are kept apart (the scene is never skipped).
   */
  private async analyzeFilm(file: FileRow & { hdrFormat: string | null }, urgent: boolean) {
    const duration = (file.durationMs ?? 0) / 1000;
    this.current = { path: file.path, since: this.now() };
    let parts: Range[] = [];
    try {
      let from = windowStart(duration);
      let samples = await this.filmWindow(file, from, duration, urgent);
      parts = filmCredits(samples, duration);
      for (let k = 0; k < 2; k++) {
        const first = parts[0];
        const earliest = duration / 2;
        // The credits run from the first frame looked at: they may start before it.
        if (!first || first.start > from + STEP_SECONDS || from <= earliest) break;
        const earlier = Math.max(earliest, from - EXTEND_SECONDS);
        samples = [...(await this.filmWindow(file, earlier, from, urgent)), ...samples];
        from = earlier;
        parts = filmCredits(samples, duration);
      }
    } catch (error) {
      if (!fileProblem(error)) throw error;
      // This file can't be read (gone, broken, too slow): nothing, until it changes.
      this.options.log?.warn(
        { err: error, file: file.path, part: 'credits' },
        'intro search: file not readable',
      );
    }
    const [first, ...more] = parts;
    const ms = (range: Range) => ({
      startMs: Math.round(range.start * 1000),
      endMs: Math.round(range.end * 1000),
    });
    await this.options.prisma.mediaFile.updateMany({
      where: { id: file.id, OR: [{ creditsSource: null }, { creditsSource: { not: 'manual' } }] },
      data: {
        creditsStartMs: first ? ms(first).startMs : null,
        creditsEndMs: first ? ms(first).endMs : null,
        creditsSource: first ? 'picture' : null,
        creditsConfidence: first ? CONFIDENCE.filmPicture : null,
        creditsMore: more.length > 0 ? more.map(ms) : Prisma.DbNull,
        creditsCheckedAt: new Date(this.now()),
      },
    });
    this.options.log?.info(
      {
        file: file.path,
        credits: parts.map((p) => `${p.start.toFixed(1)}-${p.end.toFixed(1)}`),
        source: first ? 'picture' : undefined,
      },
      'credits search (film)',
    );
  }

  /**
   * The keyframes between `from` and `to`, every STEP_SECONDS where it
   * matters: first every third one, then all of them between two that aren't
   * both film (credits, black, or a change). Most of the window before the
   * credits is film, and takes a third of the FFmpeg runs.
   */
  private async filmWindow(
    file: FileRow & { hdrFormat: string | null },
    from: number,
    to: number,
    urgent: boolean,
  ): Promise<FrameSample[]> {
    const times = sampleTimes(from, to);
    const coarse = times.filter((_, i) => i % COARSE_EVERY === 0 || i === times.length - 1);
    const first = await this.filmSamples(file, coarse, urgent);
    const kind = new Map(first.map((s) => [s.time, frameKind(s)]));
    const index = new Map(times.map((t, i) => [t, i]));
    const fill = new Set<number>();
    for (let k = 1; k < coarse.length; k++) {
      const a = coarse[k - 1] as number;
      const b = coarse[k] as number;
      // A time past the last keyframe gives no sample: look closer there too.
      if (kind.get(a) === 'other' && kind.get(b) === 'other') continue;
      for (let i = (index.get(a) ?? 0) + 1; i < (index.get(b) ?? 0); i++) {
        fill.add(times[i] as number);
      }
    }
    if (fill.size === 0) return first;
    const more = await this.filmSamples(file, [...fill], urgent);
    return [...first, ...more].sort((x, y) => x.time - y.time);
  }

  /**
   * The keyframes measured at `times`: from the cache
   * (CACHE_DIR/intro/<id>.film.json, per file version), the rest from the
   * transcoder, a few dozen at a time.
   */
  private async filmSamples(
    file: FileRow & { hdrFormat: string | null },
    times: number[],
    urgent: boolean,
  ): Promise<FrameSample[]> {
    const transcoder = this.options.transcoder;
    if (!transcoder) throw new TranscoderError(503, 'no transcoder configured');
    const version = { size: String(file.size), modifiedAt: file.modifiedAt.toISOString() };
    const cached =
      this.options.cacheDir && path.join(this.options.cacheDir, 'intro', `${file.id}.film.json`);
    let known: FrameSample[] = [];
    if (cached) {
      try {
        const saved = JSON.parse(await readFile(cached, 'utf8')) as {
          size: string;
          modifiedAt: string;
          samples: FrameSample[];
        };
        if (saved.size === version.size && saved.modifiedAt === version.modifiedAt) {
          known = saved.samples;
        }
      } catch {
        // Not there yet.
      }
    }
    const have = new Set(known.map((s) => s.time));
    const missing = times.filter((t) => !have.has(t));
    // Several FFmpeg runs at once only while nobody watches (an older transcoder ignores it).
    const jobs = !urgent && this.activity.idle(IDLE_MS) ? IDLE_FRAME_JOBS : 1;
    for (let i = 0; i < missing.length; i += FRAMES_PER_REQUEST) {
      const pause = this.options.filmPauseMs ?? PRIORITY_FRAMES_PAUSE_MS;
      if (urgent && i > 0 && pause > 0) await new Promise((r) => setTimeout(r, pause));
      const batch = missing.slice(i, i + FRAMES_PER_REQUEST);
      this.reading = { path: file.path, part: 'end', since: this.now() };
      const result = await transcoder
        .frames(
          {
            path: file.path,
            times: batch,
            ...(file.hdrFormat && { hdr: true }),
            ...(jobs > 1 && { jobs }),
          },
          Math.min(FINGERPRINT_TIMEOUT_MS, 60_000 + batch.length * FRAME_TIMEOUT_MS),
        )
        .finally(() => {
          this.reading = undefined;
        });
      known = [...known, ...result.samples];
      if (cached) {
        await mkdir(path.dirname(cached), { recursive: true });
        await writeFile(`${cached}.tmp`, JSON.stringify({ ...version, samples: known }));
        await rename(`${cached}.tmp`, cached);
      }
    }
    const wanted = new Set(times);
    return known.filter((s) => wanted.has(s.time)).sort((a, b) => a.time - b.time);
  }

  /**
   * A new episode gives the ones around it something to compare with: those
   * looked at before it was there that found nothing get another turn (the
   * first episode of a new show had no other; an episode whose one before
   * came later had no recap to find). Once: their new check is after it.
   */
  private async reopenAround(
    file: { id: string; createdAt: Date },
    episode: {
      episodeNumber: number;
      seasonId: string;
      season: { mediaItemId: string; seasonNumber: number };
    },
  ) {
    const { prisma } = this.options;
    const before = { lt: file.createdAt };
    const season = { ...searchable, id: { not: file.id }, episode: { seasonId: episode.seasonId } };
    await prisma.mediaFile.updateMany({
      where: { ...season, introSource: null, introCheckedAt: before },
      data: { introCheckedAt: null },
    });
    await prisma.mediaFile.updateMany({
      where: { ...season, creditsSource: null, creditsCheckedAt: before },
      data: { creditsCheckedAt: null },
    });
    await prisma.mediaFile.updateMany({
      where: {
        ...searchable,
        id: { not: file.id },
        recapSource: null,
        recapCheckedAt: before,
        episode: {
          OR: [
            { seasonId: episode.seasonId, episodeNumber: { gt: episode.episodeNumber } },
            {
              season: {
                mediaItemId: episode.season.mediaItemId,
                seasonNumber: episode.season.seasonNumber + 1,
              },
              episodeNumber: { lte: RECAP_EPISODES },
            },
          ],
        },
      },
      data: { recapCheckedAt: null },
    });
  }

  /**
   * The intro or the credits of one episode: from a chapter, else from the
   * audio it shares. Credits under a song of their own each episode share no
   * audio: then from the picture, like a film's.
   */
  private async find(
    file: FileRow & { hdrFormat: string | null },
    episode: {
      episodeNumber: number;
      seasonId: string;
      season: { mediaItemId: string; seasonNumber: number };
    },
    part: Window,
    urgent: boolean,
  ): Promise<Found> {
    try {
      const own = await this.print(file, part, urgent);
      const chapter = part === 'intro' ? introChapter(own.chapters) : creditsChapter(own.chapters);
      if (chapter) return { range: chapter, source: 'chapter', confidence: CONFIDENCE.chapter };
      const segments: Segment[][] = [];
      let compared = 0;
      for (const other of await this.neighbours(file.id, episode)) {
        const theirs = await this.print(other, part, urgent).catch((error: unknown) => {
          if (!fileProblem(error)) throw error;
          return undefined; // A sibling that can't be read: try the next.
        });
        if (!theirs || Math.abs(theirs.hop - own.hop) > 1e-6) continue;
        compared++;
        const shared = sharedSegments(own.frames, theirs.frames, own.hop, LIMITS[part]);
        if (shared.length > 0) segments.push(shared);
        if (segments.length >= ENOUGH) break;
      }
      const picked = pickShared(segments);
      // Frames count from where the window starts (the credits: near the end).
      if (picked) {
        return {
          range: { start: own.start + picked.start, end: own.start + picked.end },
          source: 'audio',
          confidence: sharedConfidence(picked.agree, compared),
        };
      }
      this.options.log?.info(
        { file: file.path, part, compared },
        compared === 0
          ? 'intro search: no other episode to compare with'
          : 'intro search: no shared audio',
      );
      return part === 'credits' ? await this.pictureCredits(file, urgent) : {};
    } catch (error) {
      if (!fileProblem(error)) throw error;
      // This file can't be read (gone, broken audio): nothing, until it changes.
      this.options.log?.warn(
        { err: error, file: file.path, part },
        'intro search: file not readable',
      );
      return {};
    }
  }

  /**
   * An episode's credits from the picture (film.ts), in the end window: the
   * first part is the credits, parts after a scene are kept apart. Nothing
   * when the transcoder can't measure frames of this file.
   */
  private async pictureCredits(
    file: FileRow & { hdrFormat: string | null },
    urgent: boolean,
  ): Promise<Found> {
    const duration = (file.durationMs ?? 0) / 1000;
    const samples = await this.filmWindow(file, span(file, 'credits').start, duration, urgent);
    const [first, ...more] = filmCredits(samples, duration);
    return first ? { range: first, source: 'picture', confidence: CONFIDENCE.picture, more } : {};
  }

  /**
   * The recap of one episode: a chapter, else the clips of the episodes before
   * (all of the one before, and the start and end of the two before that) that
   * this one plays in its first minutes.
   */
  private async findRecap(
    file: FileRow,
    episode: {
      episodeNumber: number;
      season: { mediaItemId: string; seasonNumber: number };
    },
    urgent: boolean,
  ): Promise<Found> {
    try {
      // The first episode recaps nothing (and its file needn't be read for it).
      const before = await this.previous(episode, RECAP_CACHED_EPISODES);
      if (before.length === 0) return {};
      const own = await this.print(file, 'intro', urgent);
      const chapter = recapChapter(own.chapters);
      if (chapter) return { range: chapter, source: 'chapter', confidence: CONFIDENCE.chapter };
      const times = await this.options.prisma.mediaFile.findMany({
        where: { id: { in: [file.id, ...before.map((f) => f.id)] } },
        select: {
          id: true,
          introStartMs: true,
          introEndMs: true,
          creditsStartMs: true,
          creditsEndMs: true,
        },
      });
      const range = (id: string, part: Window) => {
        const row = times.find((t) => t.id === id);
        const start = part === 'intro' ? row?.introStartMs : row?.creditsStartMs;
        const end = part === 'intro' ? row?.introEndMs : row?.creditsEndMs;
        return start != null && end != null ? { start: start / 1000, end: end / 1000 } : undefined;
      };
      const limit = Math.ceil(RECAP_REGION_SECONDS / own.hop);
      const found: RecapClip[] = [];
      const whole = await this.recapsInSeason(file.id, episode);
      for (const [index, other] of before.entries()) {
        // Read when needed: the one before whole (a recap shows its middle
        // too), the start and end of the two before that. The rest only from
        // the cache (a middle is there when it was the episode before of another).
        const read = (part: Window | Span) =>
          typeof part === 'string' ? index < RECAP_EPISODES : index === 0 && whole;
        const parts: (Window | Span)[] = ['intro', ...middleSpans(other), 'credits'];
        for (const part of parts) {
          const theirs = read(part)
            ? await this.print(other, part, urgent).catch((error: unknown) => {
                if (!fileProblem(error)) throw error;
                return undefined; // An older episode that can't be read: the others still count.
              })
            : await this.cachedPrint(other, part);
          if (!theirs || Math.abs(theirs.hop - own.hop) > 1e-6) continue;
          for (const clip of sharedClips(own.frames, theirs.frames, own.hop, limit)) {
            found.push({ ...clip, otherStart: theirs.start + clip.otherStart, episode: index });
          }
        }
      }
      // The same part of this episode in more places: keep the longest (the one before when equal).
      found.sort(
        (x, y) => y.end - y.start - (x.end - x.start) || (x.episode ?? 0) - (y.episode ?? 0),
      );
      const clips: RecapClip[] = [];
      for (const clip of found) {
        if (clips.some((k) => clip.start < k.end && k.start < clip.end)) continue;
        clips.push(clip);
      }
      clips.sort((a, b) => a.start - b.start);
      const intro = range(file.id, 'intro');
      const credits = range(file.id, 'credits');
      const [previous, ...older] = before.map((f) => ({
        intro: range(f.id, 'intro'),
        credits: range(f.id, 'credits'),
      }));
      const recap = scoreRecap({
        clips,
        ...(intro && { intro }),
        ...(credits && { credits }),
        ...(previous?.intro && { previousIntro: previous.intro }),
        ...(previous?.credits && { previousCredits: previous.credits }),
        earlier: older,
      });
      return recap
        ? {
            range: { start: recap.start, end: recap.end },
            source: 'audio',
            confidence: recap.confidence,
          }
        : {};
    } catch (error) {
      if (!fileProblem(error)) throw error;
      this.options.log?.warn(
        { err: error, file: file.path, part: 'recap' },
        'intro search: file not readable',
      );
      return {};
    }
  }

  /**
   * The preview of the next episode ("Next time on…") near this one's end: a
   * chapter, else the clips of the next episode that this one plays in its
   * last part. Only from the fingerprints in the cache (read for the intro,
   * credits and recaps): it reads nothing from the disks itself. Without a
   * next episode, or before the next one's start was read, nothing; it is
   * looked at again when that comes (reopenPreviewBefore).
   */
  private async findPreview(
    file: FileRow,
    episode: {
      episodeNumber: number;
      season: { mediaItemId: string; seasonNumber: number };
    },
  ): Promise<Found> {
    try {
      const own = await this.cachedPrint(file, 'credits');
      if (!own) return {};
      const chapter = previewChapter(own.chapters);
      if (chapter) return { range: chapter, source: 'chapter', confidence: CONFIDENCE.chapter };
      const next = await this.following(episode);
      if (!next) return {};
      const rows = await this.options.prisma.mediaFile.findMany({
        where: { id: { in: [file.id, next.id] } },
        select: {
          id: true,
          introStartMs: true,
          introEndMs: true,
          creditsStartMs: true,
          creditsEndMs: true,
          recapStartMs: true,
          recapEndMs: true,
        },
      });
      const range = (id: string, part: 'intro' | 'credits' | 'recap') => {
        const row = rows.find((r) => r.id === id);
        const start = row?.[`${part}StartMs`];
        const end = row?.[`${part}EndMs`];
        return start != null && end != null ? { start: start / 1000, end: end / 1000 } : undefined;
      };
      const found: Segment[] = [];
      const parts: (Window | Span)[] = ['intro', ...middleSpans(next), 'credits'];
      for (const part of parts) {
        const theirs = await this.cachedPrint(next, part);
        if (!theirs || Math.abs(theirs.hop - own.hop) > 1e-6) continue;
        for (const clip of sharedClips(own.frames, theirs.frames, own.hop)) {
          found.push({
            start: own.start + clip.start,
            end: own.start + clip.end,
            otherStart: theirs.start + clip.otherStart,
          });
        }
      }
      // The same part of this episode in more places of the next: the longest.
      found.sort((x, y) => y.end - y.start - (x.end - x.start));
      const clips: Segment[] = [];
      for (const clip of found) {
        if (clips.some((k) => clip.start < k.end && k.start < clip.end)) continue;
        clips.push(clip);
      }
      const intro = range(file.id, 'intro');
      const credits = range(file.id, 'credits');
      const nextIntro = range(next.id, 'intro');
      const nextCredits = range(next.id, 'credits');
      const nextRecap = range(next.id, 'recap');
      const preview = pickPreview({
        clips,
        duration: (file.durationMs ?? 0) / 1000,
        ...(intro && { intro }),
        ...(credits && { credits }),
        ...(nextIntro && { nextIntro }),
        ...(nextCredits && { nextCredits }),
        ...(nextRecap && { nextRecap }),
      });
      return preview
        ? {
            range: { start: preview.start, end: preview.end },
            source: 'audio',
            confidence: preview.confidence,
          }
        : {};
    } catch (error) {
      if (!fileProblem(error)) throw error;
      this.options.log?.warn(
        { err: error, file: file.path, part: 'preview' },
        'intro search: file not readable',
      );
      return {};
    }
  }

  /** The episode after this one (in the season, else the first of the next season). */
  private async following(episode: {
    episodeNumber: number;
    season: { mediaItemId: string; seasonNumber: number };
  }): Promise<FileRow | undefined> {
    const next = await this.options.prisma.mediaFile.findFirst({
      where: {
        ...searchable,
        episode: {
          season: { mediaItemId: episode.season.mediaItemId },
          OR: [
            {
              season: { seasonNumber: episode.season.seasonNumber },
              episodeNumber: { gt: episode.episodeNumber },
            },
            { season: { seasonNumber: { gt: episode.season.seasonNumber } } },
          ],
        },
      },
      orderBy: [
        { episode: { season: { seasonNumber: 'asc' } } },
        { episode: { episodeNumber: 'asc' } },
      ],
      select: fileSelect,
    });
    return next ?? undefined;
  }

  /**
   * Whether the episode before is read whole for this one's recap: not when
   * NO_RECAP_SEASON episodes of the season (not its first) were looked at and
   * none had one. Most recaps show the end of the episode before, which is
   * still compared.
   */
  private async recapsInSeason(
    fileId: string,
    episode: { season: { mediaItemId: string; seasonNumber: number } },
  ): Promise<boolean> {
    const season = {
      ...searchable,
      id: { not: fileId },
      episode: {
        episodeNumber: { gt: 1 },
        season: {
          mediaItemId: episode.season.mediaItemId,
          seasonNumber: episode.season.seasonNumber,
        },
      },
    };
    const [found, checked] = await Promise.all([
      this.options.prisma.mediaFile.count({ where: { ...season, recapStartMs: { not: null } } }),
      this.options.prisma.mediaFile.count({
        where: { ...season, recapCheckedAt: { not: null }, recapStartMs: null },
      }),
    ]);
    return found > 0 || checked < NO_RECAP_SEASON;
  }

  /** The episodes before (the nearest first): in the same season, then the seasons before. */
  private async previous(
    episode: {
      episodeNumber: number;
      season: { mediaItemId: string; seasonNumber: number };
    },
    count: number,
  ): Promise<FileRow[]> {
    return this.options.prisma.mediaFile.findMany({
      where: {
        ...searchable,
        episode: {
          season: { mediaItemId: episode.season.mediaItemId, seasonNumber: { gt: 0 } },
          OR: [
            {
              season: { seasonNumber: episode.season.seasonNumber },
              episodeNumber: { lt: episode.episodeNumber },
            },
            { season: { seasonNumber: { lt: episode.season.seasonNumber, gt: 0 } } },
          ],
        },
      },
      orderBy: [
        { episode: { season: { seasonNumber: 'desc' } } },
        { episode: { episodeNumber: 'desc' } },
      ],
      select: fileSelect,
      take: count,
    });
  }

  /** Saves what was found (or that there is nothing); what an admin set by hand meanwhile stays. */
  private async save(fileId: string, part: Part, found: Found) {
    const { prisma } = this.options;
    const at = new Date(this.options.now?.() ?? Date.now());
    const startMs = found.range ? Math.round(found.range.start * 1000) : null;
    const endMs = found.range ? Math.round(found.range.end * 1000) : null;
    const source = found.source ?? null;
    const confidence = found.range ? (found.confidence ?? null) : null;
    if (part === 'intro') {
      await prisma.mediaFile.updateMany({
        where: { id: fileId, OR: [{ introSource: null }, { introSource: { not: 'manual' } }] },
        data: {
          introStartMs: startMs,
          introEndMs: endMs,
          introSource: source,
          introConfidence: confidence,
          introCheckedAt: at,
        },
      });
    } else if (part === 'recap') {
      await prisma.mediaFile.updateMany({
        where: { id: fileId, OR: [{ recapSource: null }, { recapSource: { not: 'manual' } }] },
        data: {
          recapStartMs: startMs,
          recapEndMs: endMs,
          recapSource: source,
          recapConfidence: confidence,
          recapCheckedAt: at,
        },
      });
    } else if (part === 'preview') {
      const saved = await prisma.mediaFile.updateMany({
        where: { id: fileId, OR: [{ previewSource: null }, { previewSource: { not: 'manual' } }] },
        data: {
          previewStartMs: startMs,
          previewEndMs: endMs,
          previewSource: source,
          previewConfidence: confidence,
          previewCheckedAt: at,
        },
      });
      // The credits end where the preview starts (not ones set by hand).
      if (saved.count > 0 && startMs !== null) {
        await prisma.mediaFile.updateMany({
          where: {
            id: fileId,
            creditsSource: { not: 'manual' },
            creditsStartMs: { lt: startMs },
            creditsEndMs: { gt: startMs },
          },
          data: { creditsEndMs: startMs },
        });
      }
    } else {
      await prisma.mediaFile.updateMany({
        where: { id: fileId, OR: [{ creditsSource: null }, { creditsSource: { not: 'manual' } }] },
        data: {
          creditsStartMs: startMs,
          creditsEndMs: endMs,
          creditsSource: source,
          creditsConfidence: confidence,
          creditsMore:
            found.more && found.more.length > 0
              ? found.more.map((r) => ({
                  startMs: Math.round(r.start * 1000),
                  endMs: Math.round(r.end * 1000),
                }))
              : Prisma.DbNull,
          creditsCheckedAt: at,
        },
      });
    }
  }

  /**
   * AniSkip's times for an episode of an anime (a show in the anime-lists);
   * undefined for other shows, or when AniSkip can't be reached now. Notes
   * when it was asked, so the AniSkip pass doesn't ask again soon.
   */
  private async askAniSkip(
    file: { id: string; path: string; durationMs: number | null },
    episode: {
      episodeNumber: number;
      season: {
        seasonNumber: number;
        mediaItem: { tvdbId: number | null; tmdbId: number | null };
      };
    },
  ): Promise<SkipTimes | undefined> {
    const aniskip = this.options.aniskip;
    const now = this.options.now?.() ?? Date.now();
    if (!aniskip || !file.durationMs || now < this.aniskipPausedUntil) return undefined;
    const map = await aniskip.animeMap();
    if (!map) {
      this.aniskipPausedUntil = now + ANISKIP_PAUSE_MS;
      return undefined;
    }
    const mark = () =>
      this.options.prisma.mediaFile.update({
        where: { id: file.id },
        data: { aniskipCheckedAt: new Date(this.options.now?.() ?? Date.now()) },
      });
    const target = map.find(
      episode.season.mediaItem,
      episode.season.seasonNumber,
      episode.episodeNumber,
    );
    if (!target) {
      await mark();
      return undefined;
    }
    try {
      const times = await aniskip.skipTimes(target.malId, target.episode, file.durationMs / 1000);
      await mark();
      return times;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) {
        // AniSkip won't answer this one (a length it doesn't accept): as if unknown.
        await mark();
        return {};
      }
      this.options.log?.warn({ err: error, file: file.path }, 'aniskip not available');
      this.aniskipPausedUntil = now + ANISKIP_PAUSE_MS;
      return undefined;
    }
  }

  /**
   * Episodes already searched whose intro or credits AniSkip may know by now:
   * never asked (searched before AniSkip was used), or recent and asked some
   * days ago. What AniSkip has replaces what the audio found (not chapters or
   * what an admin set). Returns how many were looked at.
   */
  async aniskipPass(limit = ANISKIP_BATCH): Promise<number> {
    const { prisma } = this.options;
    const now = this.options.now?.() ?? Date.now();
    if (!this.options.aniskip || now < this.aniskipPausedUntil) return 0;
    const replaceable = [{ introSource: null }, { introSource: 'audio' }];
    const creditsReplaceable = [{ creditsSource: null }, { creditsSource: 'audio' }];
    const recapReplaceable = [{ recapSource: null }, { recapSource: 'audio' }];
    const files = await prisma.mediaFile.findMany({
      where: {
        ...searchable,
        introCheckedAt: { not: null },
        creditsCheckedAt: { not: null },
        AND: [
          { OR: [{ OR: replaceable }, { OR: creditsReplaceable }, { OR: recapReplaceable }] },
          {
            OR: [
              { aniskipCheckedAt: null },
              {
                aniskipCheckedAt: { lt: new Date(now - ANISKIP_RECHECK_MS) },
                addedAt: { gt: new Date(now - ANISKIP_RECENT_MS) },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        path: true,
        durationMs: true,
        episode: {
          select: {
            episodeNumber: true,
            season: {
              select: {
                seasonNumber: true,
                mediaItem: { select: { tvdbId: true, tmdbId: true } },
              },
            },
          },
        },
      },
      orderBy: { addedAt: 'desc' },
      take: limit,
    });
    for (const file of files) {
      if (!file.episode) continue;
      if (now < this.aniskipPausedUntil) return 0;
      const times = await this.askAniSkip(file, file.episode);
      const at = new Date(now);
      if (times?.intro) {
        await prisma.mediaFile.updateMany({
          where: { id: file.id, OR: replaceable },
          data: {
            introStartMs: Math.round(times.intro.start * 1000),
            introEndMs: Math.round(times.intro.end * 1000),
            introSource: 'aniskip',
            introConfidence: CONFIDENCE.aniskip,
            introCheckedAt: at,
          },
        });
      }
      if (times?.credits) {
        await prisma.mediaFile.updateMany({
          where: { id: file.id, OR: creditsReplaceable },
          data: {
            creditsStartMs: Math.round(times.credits.start * 1000),
            creditsEndMs: Math.round(times.credits.end * 1000),
            creditsSource: 'aniskip',
            creditsConfidence: CONFIDENCE.aniskip,
            creditsCheckedAt: at,
          },
        });
      }
      if (times?.recap) {
        await prisma.mediaFile.updateMany({
          where: { id: file.id, OR: recapReplaceable },
          data: {
            recapStartMs: Math.round(times.recap.start * 1000),
            recapEndMs: Math.round(times.recap.end * 1000),
            recapSource: 'aniskip',
            recapConfidence: CONFIDENCE.aniskip,
            recapCheckedAt: at,
          },
        });
      }
      if (times?.intro || times?.credits || times?.recap) {
        this.options.log?.info(
          { file: file.path, intro: times.intro, credits: times.credits, recap: times.recap },
          'aniskip times',
        );
      }
    }
    // AniSkip went down on the way: nothing done, wait.
    return now < this.aniskipPausedUntil ? 0 : files.length;
  }

  /** The episodes to compare with: nearest in the season, then the seasons around it. */
  private async neighbours(
    fileId: string,
    episode: {
      episodeNumber: number;
      seasonId: string;
      season: { mediaItemId: string; seasonNumber: number };
    },
  ): Promise<FileRow[]> {
    const { prisma } = this.options;
    const sameSeason = await prisma.mediaFile.findMany({
      where: { ...searchable, id: { not: fileId }, episode: { seasonId: episode.seasonId } },
      select: { ...fileSelect, episode: { select: { episodeNumber: true } } },
    });
    const near = (n: number) =>
      Math.abs(n - episode.episodeNumber) * 2 + (n < episode.episodeNumber ? 1 : 0);
    const chosen: FileRow[] = sameSeason
      .sort((a, b) => near(a.episode?.episodeNumber ?? 0) - near(b.episode?.episodeNumber ?? 0))
      .slice(0, NEIGHBOURS);
    if (chosen.length < 2) {
      // A season of one or two: the show's other seasons usually share the tune.
      const others = await prisma.mediaFile.findMany({
        where: {
          ...searchable,
          id: { not: fileId },
          episode: {
            season: {
              mediaItemId: episode.season.mediaItemId,
              seasonNumber: {
                gt: 0,
                in: [episode.season.seasonNumber - 1, episode.season.seasonNumber + 1],
              },
            },
          },
        },
        select: fileSelect,
        orderBy: { path: 'asc' },
        take: NEIGHBOURS,
      });
      chosen.push(...others.slice(0, NEIGHBOURS - chosen.length));
    }
    return chosen;
  }

  /** A fingerprint that is in the cache already (nothing is read from the disk), else undefined. */
  private async cachedPrint(file: FileRow, part: Window | Span): Promise<Print | undefined> {
    if (!this.options.cacheDir) return undefined;
    const version = { size: String(file.size), modifiedAt: file.modifiedAt.toISOString() };
    const { name, start } = typeof part === 'string' ? span(file, part) : part;
    const cached = path.join(this.options.cacheDir, 'intro', `${file.id}${name}.json`);
    try {
      const saved = JSON.parse(await readFile(cached, 'utf8')) as {
        size: string;
        modifiedAt: string;
        hop: number;
        frames: string;
        chapters: Chapter[];
        start?: number;
      };
      if (
        saved.size === version.size &&
        saved.modifiedAt === version.modifiedAt &&
        (saved.start ?? 0) === start &&
        Math.abs(saved.hop - FINGERPRINT_HOP) < 1e-6
      ) {
        return {
          hop: saved.hop,
          frames: decodeFrames(saved.frames),
          chapters: saved.chapters,
          start: saved.start ?? 0,
        };
      }
    } catch {
      // Not there yet.
    }
    return undefined;
  }

  /**
   * A file's fingerprint (its start, its end, or a piece of the middle): from
   * the cache, or from the transcoder (and then kept).
   */
  private async print(file: FileRow, part: Window | Span, urgent: boolean): Promise<Print> {
    const transcoder = this.options.transcoder;
    if (!transcoder) throw new TranscoderError(503, 'no transcoder configured');
    const version = { size: String(file.size), modifiedAt: file.modifiedAt.toISOString() };
    const { name, start, seconds } = typeof part === 'string' ? span(file, part) : part;
    const cached =
      this.options.cacheDir && path.join(this.options.cacheDir, 'intro', `${file.id}${name}.json`);
    const kept = await this.cachedPrint(file, part);
    if (kept) return kept;
    const tracks = (Array.isArray(file.audioTracks) ? file.audioTracks : []) as AudioTrack[];
    const track = tracks.find((t) => t.default) ?? tracks[0];
    const bitrate = file.bitrate ?? 20_000_000;
    const idle = !urgent && this.activity.idle(IDLE_MS);
    const target = urgent ? PRIORITY_READ : idle ? IDLE_READ : BACKGROUND_READ;
    const readrate =
      Math.ceil(
        Math.min(
          idle ? IDLE_READRATE : READRATE,
          Math.max(2, seconds / MAX_READ_SECONDS, target / bitrate),
        ) * 10,
      ) / 10;
    // How long the read may take: at the read rate, or as fast as the disk goes.
    const expected = Math.max(
      seconds / readrate,
      ((bitrate / 8) * seconds) / DISK_BYTES_PER_SECOND,
    );
    const reading: NonNullable<IntroService['reading']> = {
      path: file.path,
      part: name === '' ? 'start' : name === '.end' ? 'end' : 'middle',
      since: this.now(),
      seconds,
    };
    this.reading = reading;
    const started = this.now();
    const result = await transcoder
      .fingerprint(
        {
          path: file.path,
          seconds,
          ...(start > 0 && { start }),
          ...(track && { stream: track.index }),
          readrate,
        },
        // An older transcoder (no progress): a whole number, or setTimeout complains.
        Math.round(Math.min(FINGERPRINT_TIMEOUT_MS, 60_000 + 2_000 * expected)),
        // A transcoder that says how far it read: as long as it reads on.
        {
          stallMs: FINGERPRINT_STALL_MS,
          maxMs: FINGERPRINT_MAX_MS,
          onRead: (read) => {
            reading.read = read;
          },
        },
      )
      .finally(() => {
        this.reading = undefined;
      });
    const took = this.now() - started;
    if (took > 60_000) {
      this.options.log?.info(
        {
          file: file.path,
          part: name || 'start',
          seconds,
          readrate,
          took: Math.round(took / 1000),
          // What the disk gave (the file's bitrate times what was read).
          mbPerSecond: Math.round((((file.bitrate ?? 0) / 8) * seconds) / took / 1000),
        },
        'intro search: slow fingerprint',
      );
    }
    if ((result.start ?? 0) !== start) {
      // A transcoder from before the credits search reads from 0: not the end.
      throw new TranscoderError(503, 'the transcoder cannot read from a point yet; restart it');
    }
    if (Math.abs(result.hop - FINGERPRINT_HOP) > 1e-6) {
      // An older transcoder (0.124 s): its fingerprints don't compare with the new ones.
      throw new TranscoderError(503, 'the transcoder makes old fingerprints; restart it');
    }
    if (cached) {
      await mkdir(path.dirname(cached), { recursive: true });
      await writeFile(`${cached}.tmp`, JSON.stringify({ ...version, ...result, start }));
      await rename(`${cached}.tmp`, cached);
    }
    return {
      hop: result.hop,
      frames: decodeFrames(result.frames),
      chapters: result.chapters,
      start,
    };
  }

  /** What the players get for a file. */
  async info(fileId: string): Promise<IntroInfo> {
    const file = await this.options.prisma.mediaFile.findUnique({
      where: { id: fileId },
      select: introColumns,
    });
    return introInfo(file);
  }

  /** Beheer: every episode of a season with its parts, also those too uncertain for the players. */
  async seasonMarkers(seasonId: string): Promise<SeasonMarkers | undefined> {
    const season = await this.options.prisma.season.findUnique({
      where: { id: seasonId },
      include: {
        mediaItem: {
          select: {
            id: true,
            title: true,
            seasons: {
              where: { seasonNumber: { gt: 0 } },
              orderBy: { seasonNumber: 'asc' },
              select: { id: true, seasonNumber: true },
            },
          },
        },
        episodes: {
          orderBy: { episodeNumber: 'asc' },
          include: {
            files: { orderBy: { addedAt: 'desc' }, select: { id: true, ...introColumns } },
          },
        },
      },
    });
    if (!season) return undefined;
    const episodes: SeasonMarkers['episodes'] = [];
    for (const episode of season.episodes) {
      for (const file of episode.files) {
        const info = introInfo(file);
        const markers: SeasonMarkers['episodes'][number]['markers'] = {};
        const sources: Record<MarkerKind, string | undefined> = {
          intro: info.source,
          recap: info.recapSource,
          credits: info.creditsSource,
          preview: info.previewSource,
        };
        for (const kind of MARKER_KINDS) {
          const range = info[kind];
          if (!range) continue;
          const confidence = info.confidence?.[kind];
          markers[kind] = {
            ...range,
            source: sources[kind] ?? 'audio',
            ...(confidence !== undefined && { confidence }),
          };
        }
        const pending = MARKER_KINDS.filter((kind) => info[`${kind}Pending`]);
        episodes.push({
          episodeId: episode.id,
          episodeNumber: episode.episodeNumber,
          ...(episode.title && { title: episode.title }),
          fileId: file.id,
          ...(file.durationMs && { durationMs: file.durationMs }),
          markers,
          pending,
        });
      }
    }
    return {
      seasonId: season.id,
      seasonNumber: season.seasonNumber,
      itemId: season.mediaItem.id,
      title: season.mediaItem.title,
      episodes,
      seasons: season.mediaItem.seasons,
    };
  }

  /**
   * Beheer: one episode's intro on every episode of its season, by hand (a
   * show whose intro is always at the same place). The credits keep their
   * distance to the end of each file.
   */
  async copyMarker(seasonId: string, fileId: string, kind: 'intro' | 'credits'): Promise<number> {
    const { prisma } = this.options;
    const from = await prisma.mediaFile.findFirst({
      where: { id: fileId, episode: { seasonId } },
      select: {
        durationMs: true,
        introStartMs: true,
        introEndMs: true,
        creditsStartMs: true,
        creditsEndMs: true,
      },
    });
    const start = kind === 'intro' ? from?.introStartMs : from?.creditsStartMs;
    const end = kind === 'intro' ? from?.introEndMs : from?.creditsEndMs;
    if (!from || start == null || end == null) return 0;
    const others = await prisma.mediaFile.findMany({
      where: { episode: { seasonId }, id: { not: fileId } },
      select: { id: true, durationMs: true },
    });
    const at = new Date(this.now());
    let copied = 0;
    for (const other of others) {
      if (kind === 'intro') {
        if (other.durationMs && end > other.durationMs) continue;
        await prisma.mediaFile.update({
          where: { id: other.id },
          data: {
            introStartMs: start,
            introEndMs: end,
            introSource: 'manual',
            introConfidence: null,
            introCheckedAt: at,
          },
        });
      } else {
        if (!from.durationMs || !other.durationMs) continue;
        const shift = other.durationMs - from.durationMs;
        if (start + shift < 0) continue;
        await prisma.mediaFile.update({
          where: { id: other.id },
          data: {
            creditsStartMs: start + shift,
            creditsEndMs: Math.min(other.durationMs, end + shift),
            creditsSource: 'manual',
            creditsConfidence: null,
            creditsMore: Prisma.DbNull,
            creditsCheckedAt: at,
          },
        });
      }
      copied++;
    }
    return copied;
  }

  /** Beheer: a whole season looked at again (not what was set by hand), now. */
  async detectSeason(seasonId: string): Promise<number> {
    const { prisma } = this.options;
    const season = { ...searchable, episode: { seasonId } };
    const notManual = (field: string) => ({
      OR: [{ [field]: null }, { [field]: { not: 'manual' } }],
    });
    await prisma.mediaFile.updateMany({
      where: { ...season, ...notManual('introSource') },
      data: { introCheckedAt: null },
    });
    await prisma.mediaFile.updateMany({
      where: { ...season, ...notManual('creditsSource') },
      data: { creditsCheckedAt: null },
    });
    await prisma.mediaFile.updateMany({
      where: { ...season, ...notManual('recapSource') },
      data: { recapCheckedAt: null },
    });
    await prisma.mediaFile.updateMany({
      where: { ...season, ...notManual('previewSource') },
      data: { previewCheckedAt: null },
    });
    const first = await prisma.mediaFile.findFirst({
      where: season,
      orderBy: { episode: { episodeNumber: 'asc' } },
      select: { id: true },
    });
    if (first) await this.prioritize(first.id);
    return prisma.mediaFile.count({ where: season });
  }

  async status(): Promise<IntroStatus> {
    const { prisma } = this.options;
    const [
      episodes,
      checked,
      found,
      creditsChecked,
      creditsFound,
      recapChecked,
      recapFound,
      filmCount,
      filmsChecked,
      filmsFound,
      previewChecked,
      previewFound,
      uncertain,
    ] = await Promise.all([
      prisma.mediaFile.count({ where: searchable }),
      prisma.mediaFile.count({ where: { ...searchable, introCheckedAt: { not: null } } }),
      prisma.mediaFile.count({ where: { ...searchable, introStartMs: { not: null } } }),
      prisma.mediaFile.count({ where: { ...searchable, creditsCheckedAt: { not: null } } }),
      prisma.mediaFile.count({ where: { ...searchable, creditsStartMs: { not: null } } }),
      prisma.mediaFile.count({ where: { ...searchable, recapCheckedAt: { not: null } } }),
      prisma.mediaFile.count({ where: { ...searchable, recapStartMs: { not: null } } }),
      prisma.mediaFile.count({ where: films }),
      prisma.mediaFile.count({ where: { ...films, creditsCheckedAt: { not: null } } }),
      prisma.mediaFile.count({ where: { ...films, creditsStartMs: { not: null } } }),
      prisma.mediaFile.count({ where: { ...searchable, previewCheckedAt: { not: null } } }),
      prisma.mediaFile.count({ where: { ...searchable, previewStartMs: { not: null } } }),
      prisma.mediaFile.count({
        where: {
          OR: [
            { introStartMs: { not: null }, introConfidence: { lt: MIN_MARKER_CONFIDENCE } },
            { recapStartMs: { not: null }, recapConfidence: { lt: MIN_MARKER_CONFIDENCE } },
            { creditsStartMs: { not: null }, creditsConfidence: { lt: MIN_MARKER_CONFIDENCE } },
            { previewStartMs: { not: null }, previewConfidence: { lt: MIN_MARKER_CONFIDENCE } },
          ],
        },
      }),
    ]);
    return {
      episodes,
      checked,
      found,
      creditsChecked,
      creditsFound,
      recapChecked,
      recapFound,
      films: filmCount,
      filmsChecked,
      filmsFound,
      previewChecked,
      previewFound,
      uncertain,
      ...(this.current && {
        current: this.current.path,
        currentSince: new Date(this.current.since).toISOString(),
      }),
      ...(this.reading && {
        reading: { ...this.reading, since: new Date(this.reading.since).toISOString() },
      }),
      ...(this.waiting && { waiting: this.waiting }),
      ...(this.rush && { rush: true }),
      ...(!this.rush && this.rushStopped && { rushStopped: this.rushStopped }),
    };
  }
}

/** The columns introInfo needs. */
export const introColumns = {
  introStartMs: true,
  introEndMs: true,
  introSource: true,
  introCheckedAt: true,
  creditsStartMs: true,
  creditsEndMs: true,
  creditsSource: true,
  creditsCheckedAt: true,
  creditsMore: true,
  recapStartMs: true,
  recapEndMs: true,
  recapSource: true,
  recapCheckedAt: true,
  previewStartMs: true,
  previewEndMs: true,
  previewSource: true,
  previewCheckedAt: true,
  introConfidence: true,
  creditsConfidence: true,
  recapConfidence: true,
  previewConfidence: true,
  durationMs: true,
  probeError: true,
  episode: { select: { season: { select: { seasonNumber: true } } } },
  mediaItem: { select: { type: true } },
} as const;

/** IntroInfo (intro, credits and recap) from the file's columns: only episodes the search covers are ever pending. */
export function introInfo(
  file:
    | {
        introStartMs: number | null;
        introEndMs: number | null;
        introSource: string | null;
        introCheckedAt: Date | null;
        creditsStartMs: number | null;
        creditsEndMs: number | null;
        creditsSource: string | null;
        creditsCheckedAt: Date | null;
        /** Films: the parts of the credits after the first; older callers leave it out. */
        creditsMore?: unknown;
        recapStartMs: number | null;
        recapEndMs: number | null;
        recapSource: string | null;
        recapCheckedAt: Date | null;
        /** The preview and the confidences; older callers leave them out. */
        previewStartMs?: number | null;
        previewEndMs?: number | null;
        previewSource?: string | null;
        previewCheckedAt?: Date | null;
        introConfidence?: number | null;
        creditsConfidence?: number | null;
        recapConfidence?: number | null;
        previewConfidence?: number | null;
        durationMs: number | null;
        probeError: string | null;
        episode: { season: { seasonNumber: number } } | null;
        /** Films get the credits search; older callers leave it out. */
        mediaItem?: { type: string } | null;
      }
    | null
    | undefined,
  /** `all: false` (the players): parts too uncertain are left out, and named in `hidden`. */
  options: { all?: boolean } = {},
): IntroInfo {
  if (!file) return { pending: false };
  const covered =
    (file.episode?.season.seasonNumber ?? 0) > 0 &&
    (file.durationMs ?? 0) >= MIN_DURATION_MS &&
    file.probeError === null;
  const film =
    !file.episode &&
    file.mediaItem?.type === 'MOVIE' &&
    (file.durationMs ?? 0) >= MIN_FILM_DURATION_MS &&
    file.probeError === null;
  const introPending = covered && file.introCheckedAt === null && file.introSource !== 'manual';
  const creditsPending =
    (covered || film) && file.creditsCheckedAt === null && file.creditsSource !== 'manual';
  const recapPending = covered && file.recapCheckedAt === null && file.recapSource !== 'manual';
  const previewPending =
    covered &&
    file.previewCheckedAt === null &&
    file.previewSource !== 'manual' &&
    file.previewStartMs !== undefined;
  const confidence: Partial<Record<MarkerKind, number>> = {};
  const hidden: MarkerKind[] = [];
  for (const kind of MARKER_KINDS) {
    const value = file[`${kind}Confidence`];
    if (typeof value !== 'number') continue;
    confidence[kind] = Math.round(value * 100) / 100;
    if (options.all === false && value < MIN_MARKER_CONFIDENCE) hidden.push(kind);
  }
  const shown = (kind: MarkerKind) => !hidden.includes(kind);
  const moreCredits = Array.isArray(file.creditsMore)
    ? (file.creditsMore as { startMs?: unknown; endMs?: unknown }[]).filter(
        (r): r is { startMs: number; endMs: number } =>
          typeof r?.startMs === 'number' && typeof r.endMs === 'number',
      )
    : [];
  type Source = NonNullable<IntroInfo['source']>;
  return {
    ...(file.introStartMs !== null &&
      file.introEndMs !== null &&
      shown('intro') && {
        intro: { startMs: file.introStartMs, endMs: file.introEndMs },
      }),
    ...(file.introSource && { source: file.introSource as Source }),
    ...(file.creditsStartMs !== null &&
      file.creditsEndMs !== null &&
      shown('credits') && {
        credits: { startMs: file.creditsStartMs, endMs: file.creditsEndMs },
      }),
    ...(file.creditsSource && { creditsSource: file.creditsSource as Source }),
    ...(moreCredits.length > 0 &&
      shown('credits') && {
        moreCredits: moreCredits.map((r) => ({ startMs: r.startMs, endMs: r.endMs })),
      }),
    ...(file.recapStartMs !== null &&
      file.recapEndMs !== null &&
      shown('recap') && {
        recap: { startMs: file.recapStartMs, endMs: file.recapEndMs },
      }),
    ...(file.recapSource && { recapSource: file.recapSource as Source }),
    ...(file.previewStartMs != null &&
      file.previewEndMs != null &&
      shown('preview') && {
        preview: { startMs: file.previewStartMs, endMs: file.previewEndMs },
      }),
    ...(file.previewSource && {
      previewSource: file.previewSource as NonNullable<IntroInfo['previewSource']>,
    }),
    ...(Object.keys(confidence).length > 0 && { confidence }),
    ...(hidden.length > 0 && { hidden }),
    pending: introPending || creditsPending || recapPending || previewPending,
    introPending,
    creditsPending,
    recapPending,
    previewPending,
  };
}
