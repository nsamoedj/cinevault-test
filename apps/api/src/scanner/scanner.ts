// Library scanner: files → items/seasons/episodes/files → ffprobe → metadata.
// Read-only on the media folders (CLAUDE.md).

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ScanStatus } from '@cinevault/shared';
import {
  type Library,
  type MediaItem,
  Prisma,
  type PrismaClient,
} from '../generated/prisma/client.js';
import { type ImageCache, LOCAL_BACKDROPS, LOCAL_POSTERS } from '../images.js';
import type { MetadataService } from '../metadata/service.js';
import { matchSidecars } from '../subtitles/sidecar.js';
import {
  applyFailed,
  applyMovie,
  applyShow,
  applyUnmatched,
  type LocalArtwork,
  sortTitle,
} from './apply.js';
import { isVideoFile, parseLibraryPath, type ParsedEpisode, type ParsedMovie } from './parse.js';
import type { Prober } from './probe.js';
import { walk, type WalkedFile } from './walk.js';

export interface ScannerLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ScannerOptions {
  prisma: PrismaClient;
  /** MEDIA_ROOT inside the container. */
  mediaRoot: string;
  probe: Prober;
  metadata: MetadataService;
  images: ImageCache;
  logger: ScannerLogger;
  probeConcurrency?: number;
  metadataConcurrency?: number;
  /**
   * After a library is scanned, with when its scan began (what was made since
   * is new): notifications. Its errors are logged, not the scan's.
   */
  onLibraryScanned?: (scan: {
    libraryId: string;
    libraryName: string;
    startedAt: Date;
    firstScan: boolean;
  }) => Promise<unknown>;
}

export interface ScanRequest {
  libraryId?: string;
  /**
   * Fetch metadata again for every item: matched items by their known id
   * (a correct match is never replaced by a new search), others by search.
   */
  refreshMetadata?: boolean;
}

const MAX_ERRORS = 50;
/** Matched shows are refreshed after this long, to pick up new episodes. */
const SHOW_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Movies matched before release dates were stored get them on the next scan. */
const RELEASE_DATES_SINCE = new Date('2026-10-17T21:00:00Z');
/** Titles matched before logos, trailers, recommendations and next episodes were stored. */
const EXTRAS_SINCE = new Date('2026-10-18T08:00:00Z');
/** TMDB titles matched before age ratings (kids profiles) were stored. */
const AGE_RATINGS_SINCE = new Date('2026-10-18T23:30:00Z');
/** Films matched before collections were kept: fetched once more, for the collection. */
const COLLECTIONS_SINCE = new Date('2026-10-21T13:00:00Z');
/** Shows matched before their air dates were stored (the calendar). */
const SCHEDULE_SINCE = new Date('2026-10-19T11:00:00Z');

function startOfToday(): Date {
  return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyStatus(): ScanStatus {
  return {
    running: false,
    phase: 'idle',
    filesFound: 0,
    filesProbed: 0,
    probeErrors: 0,
    filesRemoved: 0,
    itemsTotal: 0,
    itemsMatched: 0,
    itemsUnmatched: 0,
    itemsFailed: 0,
    errors: [],
  };
}

interface MovieGroup {
  parsed: ParsedMovie;
  files: WalkedFile[];
}

interface ShowGroup {
  parsed: ParsedEpisode;
  episodes: { parsed: ParsedEpisode; file: WalkedFile }[];
}

export class Scanner {
  private status: ScanStatus = emptyStatus();
  private current: Promise<void> | undefined;

  constructor(private readonly options: ScannerOptions) {}

  getStatus(): ScanStatus {
    return structuredClone(this.status);
  }

  /** Starts a scan in the background. Returns false when one is already running. */
  start(request: ScanRequest = {}): boolean {
    if (this.current) return false;
    this.current = this.run(request).finally(() => {
      this.current = undefined;
    });
    return true;
  }

  /** Runs a scan and waits for it (tests, scripts). */
  async scan(request: ScanRequest = {}): Promise<ScanStatus> {
    if (!this.start(request)) throw new Error('a scan is already running');
    await this.current;
    return this.getStatus();
  }

  /**
   * An upgrade by Sonarr or Radarr is a new path (the quality is in the name):
   * the progress on the old file goes to the new file of the same episode or
   * film, so that "gezien" and "verder kijken" stay.
   */
  private async keepProgress(gone: string[]): Promise<void> {
    const { prisma } = this.options;
    const rows = await prisma.mediaFile.findMany({
      where: { path: { in: gone }, watchProgress: { some: {} } },
      select: { id: true, episodeId: true, mediaItemId: true },
    });
    for (const row of rows) {
      const owner = row.episodeId
        ? { episodeId: row.episodeId }
        : row.mediaItemId
          ? { mediaItemId: row.mediaItemId, episodeId: null }
          : undefined;
      if (!owner) continue;
      const successor = await prisma.mediaFile.findFirst({
        where: { ...owner, path: { notIn: gone } },
        orderBy: { addedAt: 'desc' },
        select: { id: true },
      });
      if (!successor) continue;
      const progress = await prisma.watchProgress.findMany({ where: { mediaFileId: row.id } });
      for (const entry of progress) {
        const there = await prisma.watchProgress.findUnique({
          where: { userId_mediaFileId: { userId: entry.userId, mediaFileId: successor.id } },
        });
        if (!there) {
          await prisma.watchProgress.update({
            where: { id: entry.id },
            // The same moment: "Verder kijken" keeps its order.
            data: { mediaFileId: successor.id, updatedAt: entry.updatedAt },
          });
        } else if (entry.completed && !there.completed) {
          await prisma.watchProgress.update({ where: { id: there.id }, data: { completed: true } });
        }
      }
    }
  }
  private error(message: string, details: object = {}) {
    this.options.logger.warn(details, message);
    if (this.status.errors.length < MAX_ERRORS) this.status.errors.push(message);
  }

  private async run(request: ScanRequest): Promise<void> {
    const { prisma, logger } = this.options;
    this.status = {
      ...emptyStatus(),
      running: true,
      phase: 'files',
      startedAt: new Date().toISOString(),
    };
    try {
      const libraries = await prisma.library.findMany({
        where: request.libraryId ? { id: request.libraryId } : {},
        orderBy: { name: 'asc' },
      });
      for (const library of libraries) {
        this.status.libraryName = library.name;
        await this.scanLibrary(library, request);
      }
    } catch (error) {
      logger.error({ err: error }, 'scan failed');
      this.error(`scan failed: ${errorMessage(error)}`);
    } finally {
      this.status.running = false;
      this.status.phase = 'done';
      this.status.finishedAt = new Date().toISOString();
      delete this.status.libraryName;
      logger.info({ status: this.status }, 'scan finished');
    }
  }

  private async scanLibrary(library: Library, request: ScanRequest): Promise<void> {
    const { prisma, mediaRoot } = this.options;
    const startedAt = new Date();
    const libraryRoot = path.join(mediaRoot, ...library.path.split('/'));
    const prefix = `${library.path}/`;

    // 1. Files on disk.
    this.status.phase = 'files';
    const rootInfo = await stat(libraryRoot).catch(() => undefined);
    // Folders and files that could not be read this time (a hiccup of the bind
    // mount, Sonarr moving a folder): what is known below them is not gone.
    const unreadable: string[] = [];
    const { files, namesByDir, subtitlesByDir } = rootInfo?.isDirectory()
      ? await walk(libraryRoot, (dir, error) => {
          unreadable.push(`${prefix}${dir}`.replace(/\/$/, ''));
          this.error(`cannot read ${library.path}/${dir}: ${errorMessage(error)}`);
        })
      : {
          files: [],
          namesByDir: new Map<string, Set<string>>(),
          subtitlesByDir: new Map<string, string[]>(),
        };
    this.status.filesFound += files.length;

    const movies = new Map<string, MovieGroup>();
    const shows = new Map<string, ShowGroup>();
    for (const file of files) {
      const parsed = parseLibraryPath(library.type, file.relPath);
      if (parsed.kind === 'movie') {
        const group = movies.get(parsed.itemPath) ?? { parsed, files: [] };
        group.files.push(file);
        movies.set(parsed.itemPath, group);
      } else if (parsed.kind === 'episode') {
        const group = shows.get(parsed.itemPath) ?? { parsed, episodes: [] };
        group.episodes.push({ parsed, file });
        shows.set(parsed.itemPath, group);
      } else if (parsed.reason !== 'extra') {
        this.error(`skipped ${prefix}${file.relPath}: ${parsed.reason}`);
      }
    }

    const existing = new Map(
      (
        await prisma.mediaFile.findMany({
          where: { path: { startsWith: prefix } },
          select: {
            id: true,
            path: true,
            size: true,
            modifiedAt: true,
            probedAt: true,
            hdrFormat: true,
            dvProfile: true,
            episode: {
              select: { id: true, absoluteNumber: true, season: { select: { mediaItemId: true } } },
            },
          },
        })
      ).map((f) => [f.path, f]),
    );

    // Sidecar subtitles known from earlier scans, per file id.
    const knownSidecars = new Map<string, { id: string; externalId: string }[]>();
    for (const row of await prisma.subtitle.findMany({
      where: { source: 'EXTERNAL', mediaFile: { path: { startsWith: prefix } } },
      select: { id: true, mediaFileId: true, externalId: true },
    })) {
      const list = knownSidecars.get(row.mediaFileId) ?? [];
      list.push(row);
      knownSidecars.set(row.mediaFileId, list);
    }

    /** Subtitle files next to a video become (or stop being) EXTERNAL subtitles. */
    const syncSidecars = async (fileId: string, file: WalkedFile) => {
      const slash = file.relPath.lastIndexOf('/');
      const dir = slash >= 0 ? file.relPath.slice(0, slash) : '';
      const name = file.relPath.slice(slash + 1);
      const sidecars = matchSidecars(name, subtitlesByDir.get(dir) ?? []);
      const known = knownSidecars.get(fileId) ?? [];
      if (sidecars.length === 0 && known.length === 0) return;
      const wanted = new Map(
        sidecars.map((s) => [`${prefix}${dir ? `${dir}/` : ''}${s.name}`, s] as const),
      );
      const stale = known.filter((k) => !wanted.has(k.externalId));
      if (stale.length > 0) {
        await prisma.subtitle.deleteMany({ where: { id: { in: stale.map((k) => k.id) } } });
      }
      for (const [relPath, sidecar] of wanted) {
        const data = {
          language: sidecar.language ?? 'und',
          label: sidecar.label ?? null,
          forced: sidecar.forced,
          hearingImpaired: sidecar.hearingImpaired,
          path: `media:${relPath}`,
        };
        await prisma.subtitle.upsert({
          where: {
            mediaFileId_source_externalId: {
              mediaFileId: fileId,
              source: 'EXTERNAL',
              externalId: relPath,
            },
          },
          create: { mediaFileId: fileId, source: 'EXTERNAL', externalId: relPath, ...data },
          update: data,
        });
      }
    };

    const localArtwork = (itemPath: string): LocalArtwork => {
      const names = namesByDir.get(itemPath);
      const poster = LOCAL_POSTERS.find((n) => names?.has(n));
      const backdrop = LOCAL_BACKDROPS.find((n) => names?.has(n));
      return {
        ...(poster && { posterRef: `media:${prefix}${itemPath}/${poster}` }),
        ...(backdrop && { backdropRef: `media:${prefix}${itemPath}/${backdrop}` }),
      };
    };

    // 2. Items, seasons, episodes and file rows.
    const toProbe: { id: string; absPath: string; changed: boolean }[] = [];
    const seen = new Set<string>();
    const itemsWithNewFiles = new Set<string>();
    const artworkByItem = new Map<string, LocalArtwork>();

    const upsertFile = async (
      file: WalkedFile,
      link: { mediaItemId: string; episodeId: string | null },
      itemId: string,
    ) => {
      const relPath = `${prefix}${file.relPath}`;
      seen.add(relPath);
      const known = existing.get(relPath);
      const changed =
        !known ||
        known.size !== BigInt(file.size) ||
        known.modifiedAt.getTime() !== file.modifiedAt.getTime();
      const row = await prisma.mediaFile.upsert({
        where: { path: relPath },
        create: {
          path: relPath,
          size: BigInt(file.size),
          modifiedAt: file.modifiedAt,
          // Arrived when written, unless the mtime is in the future (a wrong clock).
          addedAt: new Date(Math.min(Date.now(), file.modifiedAt.getTime())),
          mediaItemId: link.episodeId ? null : link.mediaItemId,
          episodeId: link.episodeId,
        },
        update: {
          size: BigInt(file.size),
          modifiedAt: file.modifiedAt,
          mediaItemId: link.episodeId ? null : link.mediaItemId,
          episodeId: link.episodeId,
        },
      });
      if (!known) itemsWithNewFiles.add(itemId);
      // Probed before the Dolby Vision profile was stored: once more. A file whose
      // profile ffprobe can't tell is not probed again on every scan.
      const dvUnknown =
        known?.hdrFormat === 'DV' &&
        known.dvProfile === null &&
        Boolean(known.probedAt && known.probedAt < EXTRAS_SINCE);
      if (changed || !known.probedAt || dvUnknown) {
        toProbe.push({ id: row.id, absPath: file.absPath, changed });
      }
      await syncSidecars(row.id, file);
    };

    for (const [itemPath, group] of movies) {
      const item = await this.upsertItem(library, `${prefix}${itemPath}`, 'MOVIE', group.parsed);
      // A loose file in the library root has no folder of its own to hold artwork.
      const loose = group.files.some((f) => f.relPath === itemPath);
      const artwork = loose ? {} : localArtwork(itemPath);
      artworkByItem.set(item.id, artwork);
      await this.syncLocalArtwork(item, artwork);
      for (const file of group.files)
        await upsertFile(file, { mediaItemId: item.id, episodeId: null }, item.id);
    }

    for (const [itemPath, group] of shows) {
      const item = await this.upsertItem(library, `${prefix}${itemPath}`, 'SHOW', group.parsed);
      const artwork = localArtwork(itemPath);
      artworkByItem.set(item.id, artwork);
      await this.syncLocalArtwork(item, artwork);
      for (const { parsed, file } of group.episodes) {
        if (parsed.season === undefined && parsed.absolute !== undefined) {
          // Already placed by metadata (see applyShow): keep it there.
          const placed = existing.get(`${prefix}${file.relPath}`)?.episode;
          if (placed?.absoluteNumber === parsed.absolute && placed.season.mediaItemId === item.id) {
            await upsertFile(file, { mediaItemId: item.id, episodeId: placed.id }, item.id);
            continue;
          }
        }
        // Absolute-only files go to season 1 until metadata tells where they belong.
        const seasonNumber = parsed.season ?? 1;
        const episodeNumber = parsed.episodes[0] ?? 0;
        const season = await prisma.season.upsert({
          where: { mediaItemId_seasonNumber: { mediaItemId: item.id, seasonNumber } },
          create: { mediaItemId: item.id, seasonNumber },
          update: {},
        });
        const episode = await prisma.episode.upsert({
          where: { seasonId_episodeNumber: { seasonId: season.id, episodeNumber } },
          create: {
            seasonId: season.id,
            episodeNumber,
            ...(parsed.season === undefined &&
              parsed.absolute !== undefined && {
                absoluteNumber: parsed.absolute,
              }),
            ...(parsed.episodeTitle && { title: parsed.episodeTitle }),
          },
          update: {},
        });
        await upsertFile(file, { mediaItemId: item.id, episodeId: episode.id }, item.id);
      }
    }

    // 3. ffprobe for new and changed files.
    this.status.phase = 'probe';
    await pool(toProbe, this.options.probeConcurrency ?? 4, async (file) => {
      try {
        const result = await this.options.probe(file.absPath);
        await prisma.mediaFile.update({
          where: { id: file.id },
          data: {
            container: result.container ?? null,
            videoCodec: result.videoCodec ?? null,
            width: result.width ?? null,
            height: result.height ?? null,
            bitDepth: result.bitDepth ?? null,
            hdrFormat: result.hdrFormat ?? null,
            dvProfile: result.dvProfile ?? null,
            dvCompatibility: result.dvCompatibility ?? null,
            durationMs: result.durationMs ?? null,
            bitrate: result.bitrate ?? null,
            audioTracks: result.audioTracks as unknown as Prisma.InputJsonValue,
            subtitleTracks: result.subtitleTracks as unknown as Prisma.InputJsonValue,
            probedAt: new Date(),
            probeError: null,
          },
        });
        if (file.changed) {
          // A changed file: look for the intro, credits and recap again, unless an admin set them by hand.
          await prisma.mediaFile.updateMany({
            where: { id: file.id, OR: [{ introSource: null }, { introSource: { not: 'manual' } }] },
            data: { introStartMs: null, introEndMs: null, introSource: null, introCheckedAt: null },
          });
          await prisma.mediaFile.updateMany({
            where: {
              id: file.id,
              OR: [{ creditsSource: null }, { creditsSource: { not: 'manual' } }],
            },
            data: {
              creditsStartMs: null,
              creditsEndMs: null,
              creditsSource: null,
              creditsCheckedAt: null,
              creditsMore: Prisma.DbNull,
            },
          });
          await prisma.mediaFile.updateMany({
            where: { id: file.id, OR: [{ recapSource: null }, { recapSource: { not: 'manual' } }] },
            data: { recapStartMs: null, recapEndMs: null, recapSource: null, recapCheckedAt: null },
          });
          // Another release may have other times on AniSkip too.
          await prisma.mediaFile.update({
            where: { id: file.id },
            data: { aniskipCheckedAt: null },
          });
          // A changed file may have other tracks: forget what was read from the old one.
          await prisma.subtitle.deleteMany({ where: { mediaFileId: file.id, source: 'EMBEDDED' } });
        }
        this.status.filesProbed++;
      } catch (error) {
        this.status.probeErrors++;
        this.error(`ffprobe failed for ${path.basename(file.absPath)}: ${errorMessage(error)}`);
        await prisma.mediaFile.update({
          where: { id: file.id },
          data: { probedAt: new Date(), probeError: errorMessage(error).slice(0, 1000) },
        });
      }
    });

    // 4. Files that are gone. An empty or missing folder usually means an
    // unplugged disk or offline NAS, not a deleted library: then remove nothing.
    const missing = [...existing.keys()].filter((p) => !seen.has(p));
    const gone = missing.filter((p) => !unreadable.some((u) => p === u || p.startsWith(`${u}/`)));
    if (gone.length < missing.length) {
      this.error(
        `kept ${missing.length - gone.length} known files below folders that could not be read`,
      );
    }
    if (gone.length > 0 && files.length === 0) {
      this.error(
        `${library.path} is empty or unavailable; kept ${gone.length} known files. Check MEDIA_ROOT and the disk.`,
      );
    } else if (gone.length > 0) {
      await this.keepProgress(gone);
      const removed = await prisma.mediaFile.deleteMany({ where: { path: { in: gone } } });
      this.status.filesRemoved += removed.count;
      await prisma.episode.deleteMany({
        where: { files: { none: {} }, season: { mediaItem: { libraryId: library.id } } },
      });
      await prisma.season.deleteMany({
        where: { episodes: { none: {} }, mediaItem: { libraryId: library.id } },
      });
      await prisma.mediaItem.deleteMany({
        where: { libraryId: library.id, files: { none: {} }, seasons: { none: {} } },
      });
    }

    // When each title's newest file arrived (for "Nieuw toegevoegd").
    await prisma.$executeRaw`
      UPDATE "MediaItem" i SET "addedAt" = latest.at
      FROM (
        SELECT coalesce(f."mediaItemId", s."mediaItemId") AS id, max(f."addedAt") AS at
        FROM "MediaFile" f
        LEFT JOIN "Episode" e ON e.id = f."episodeId"
        LEFT JOIN "Season" s ON s.id = e."seasonId"
        WHERE starts_with(f.path, ${prefix})
        GROUP BY 1
      ) latest
      WHERE latest.id = i.id AND i."addedAt" IS DISTINCT FROM latest.at`;

    // 5. Metadata.
    this.status.phase = 'metadata';
    const staleBefore = new Date(Date.now() - SHOW_REFRESH_MS);
    // Note: an empty object inside OR matches nothing in Prisma, so a refresh
    // needs a filter without OR rather than an extra `{}` branch.
    const items = await prisma.mediaItem.findMany({
      where: request.refreshMetadata
        ? { libraryId: library.id }
        : {
            libraryId: library.id,
            OR: [
              { metadataStatus: { in: ['PENDING', 'FAILED'] } },
              { id: { in: [...itemsWithNewFiles] } },
              { type: 'SHOW', metadataStatus: 'MATCHED', metadataUpdatedAt: { lt: staleBefore } },
              {
                type: 'MOVIE',
                metadataStatus: 'MATCHED',
                releaseDate: null,
                metadataUpdatedAt: { lt: RELEASE_DATES_SINCE },
              },
              { metadataStatus: 'MATCHED', metadataUpdatedAt: { lt: EXTRAS_SINCE } },
              {
                metadataStatus: 'MATCHED',
                metadataProvider: { contains: 'tmdb' },
                ageRating: null,
                metadataUpdatedAt: { lt: AGE_RATINGS_SINCE },
              },
              {
                type: 'SHOW',
                metadataStatus: 'MATCHED',
                metadataUpdatedAt: { lt: SCHEDULE_SINCE },
              },
              {
                type: 'MOVIE',
                metadataStatus: 'MATCHED',
                metadataProvider: { contains: 'tmdb' },
                metadataUpdatedAt: { lt: COLLECTIONS_SINCE },
              },
              // The next episode aired: ask which one comes after it.
              {
                type: 'SHOW',
                metadataStatus: 'MATCHED',
                nextEpisodeAirDate: { lt: startOfToday() },
              },
            ],
          },
    });
    this.status.itemsTotal += items.length;
    await pool(items, this.options.metadataConcurrency ?? 3, async (item) => {
      const artwork = artworkByItem.get(item.id) ?? {};
      await this.updateMetadata(item, artwork);
    });

    await prisma.library.update({ where: { id: library.id }, data: { lastScannedAt: new Date() } });
    if (this.options.onLibraryScanned) {
      await this.options
        .onLibraryScanned({
          libraryId: library.id,
          libraryName: library.name,
          startedAt,
          firstScan: !library.lastScannedAt,
        })
        .catch((error: unknown) =>
          this.options.logger.warn({ err: error }, 'after-scan notifications failed'),
        );
    }
  }

  private async upsertItem(
    library: Library,
    itemPath: string,
    type: 'MOVIE' | 'SHOW',
    parsed: ParsedMovie | ParsedEpisode,
  ): Promise<MediaItem> {
    const title = parsed.kind === 'movie' ? parsed.title : parsed.showTitle;
    const year = parsed.kind === 'movie' ? parsed.year : parsed.showYear;
    return this.options.prisma.mediaItem.upsert({
      where: { libraryId_path: { libraryId: library.id, path: itemPath } },
      create: {
        libraryId: library.id,
        path: itemPath,
        type,
        title,
        sortTitle: sortTitle(title),
        year: year ?? null,
        // Id hints from folder names, e.g. "{tmdb-27205}".
        tmdbId: parsed.ids.tmdb ?? null,
        tvdbId: parsed.ids.tvdb ?? null,
        imdbId: parsed.ids.imdb ?? null,
      },
      update: {},
    });
  }

  /**
   * The owner's own artwork applies right away, also before or without a match.
   * When it disappears, a matched item is looked up again to get the provider image back.
   */
  private async syncLocalArtwork(item: MediaItem, artwork: LocalArtwork): Promise<void> {
    const keep = (current: string | null) => (current?.startsWith('media:') ? null : current);
    const posterPath = artwork.posterRef ?? keep(item.posterPath);
    const backdropPath = artwork.backdropRef ?? keep(item.backdropPath);
    if (posterPath === item.posterPath && backdropPath === item.backdropPath) return;
    const lostLocal =
      (item.posterPath?.startsWith('media:') && !artwork.posterRef) ||
      (item.backdropPath?.startsWith('media:') && !artwork.backdropRef);
    await this.options.prisma.mediaItem.update({
      where: { id: item.id },
      data: {
        posterPath,
        backdropPath,
        ...(lostLocal && item.metadataStatus === 'MATCHED' && { metadataStatus: 'PENDING' }),
      },
    });
  }

  /** The owner's own poster/backdrop in an item's folder (for manual matches). */
  async localArtworkFor(item: Pick<MediaItem, 'path'>): Promise<LocalArtwork> {
    if (isVideoFile(item.path)) return {};
    const folder = path.join(this.options.mediaRoot, ...item.path.split('/'));
    const names = new Set(
      (await readdir(folder).catch(() => [] as string[])).map((n) => n.toLowerCase()),
    );
    const poster = LOCAL_POSTERS.find((n) => names.has(n));
    const backdrop = LOCAL_BACKDROPS.find((n) => names.has(n));
    return {
      ...(poster && { posterRef: `media:${item.path}/${poster}` }),
      ...(backdrop && { backdropRef: `media:${item.path}/${backdrop}` }),
    };
  }

  /**
   * Looks up and stores metadata for one item. Matched or locked items are
   * refreshed by their known id; others are matched by hints and title.
   */
  async updateMetadata(item: MediaItem, artwork: LocalArtwork): Promise<void> {
    const { prisma, metadata, images } = this.options;
    try {
      // metadataProvider is set once an item has been matched (and cleared when a
      // match is undone): refresh those by id, search only for new items.
      const known = item.matchLocked || item.metadataProvider ? knownId(item) : undefined;
      const hints = {
        ...(item.tmdbId && { tmdb: item.tmdbId }),
        ...(item.tvdbId && { tvdb: item.tvdbId }),
        ...(item.imdbId && { imdb: item.imdbId }),
        ...(known?.provider === 'tvmaze' && item.tvmazeId && { tvmaze: item.tvmazeId }),
      };
      const query = { title: item.title, ...(item.year && { year: item.year }), ids: hints };

      if (item.type === 'MOVIE') {
        const result = known
          ? await metadata.fetchMovie(known.id)
          : await metadata.matchMovie(query);
        if (result.status === 'matched') {
          await applyMovie(prisma, item, result.metadata, result.sources, artwork);
          this.status.itemsMatched++;
        } else {
          await applyUnmatched(prisma, item, result);
          this.status.itemsUnmatched++;
        }
      } else {
        const seasons = await prisma.season.findMany({
          where: { mediaItemId: item.id },
          select: { seasonNumber: true, episodes: { select: { absoluteNumber: true } } },
        });
        const showQuery = {
          ...query,
          seasons: seasons.map((s) => s.seasonNumber),
          needsAbsolute: seasons.some((s) => s.episodes.some((e) => e.absoluteNumber !== null)),
        };
        const result = known
          ? await metadata.fetchShow(known.provider, known.id, showQuery)
          : await metadata.matchShow(showQuery);
        if (result.status === 'matched') {
          await applyShow(prisma, item, result.metadata, result.sources, artwork);
          this.status.itemsMatched++;
        } else {
          await applyUnmatched(prisma, item, result);
          this.status.itemsUnmatched++;
        }
      }

      const updated = await prisma.mediaItem.findUnique({
        where: { id: item.id },
        select: { posterPath: true, backdropPath: true },
      });
      await images.prefetch(updated?.posterPath);
      await images.prefetch(updated?.backdropPath);
    } catch (error) {
      this.status.itemsFailed++;
      this.error(`metadata failed for "${item.title}": ${errorMessage(error)}`, { err: error });
      await applyFailed(prisma, item, error);
    }
  }
}

function knownId(item: MediaItem): { provider: 'tmdb' | 'tvmaze'; id: number } | undefined {
  // "tmdb+tvmaze" means TMDB with seasons filled from TVmaze: TMDB is primary.
  if (item.metadataProvider?.startsWith('tvmaze') && item.tvmazeId) {
    return { provider: 'tvmaze', id: item.tvmazeId };
  }
  if (item.tmdbId) return { provider: 'tmdb', id: item.tmdbId };
  if (item.tvmazeId) return { provider: 'tvmaze', id: item.tvmazeId };
  return undefined;
}
