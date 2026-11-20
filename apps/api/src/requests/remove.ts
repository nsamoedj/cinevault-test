// Removing a title, a season or an episode (admins). CineVault never writes
// in the media folders: it asks Radarr or Sonarr, which own the files, to
// delete them, and then scans the library, which drops what is gone.
//
// - A film: Radarr removes the movie with its folder and files.
// - A whole show: Sonarr removes the series with its folder and files.
// - A season or an episode: Sonarr deletes those episode files and stops
//   monitoring the episodes, so it doesn't download them again.

import type { RemovePreview, RemoveResult, RemoveTarget } from '@cinevault/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ScanQueue } from '../scanQueue.js';
import type { ArrTitle, EpisodeFileRecord, RadarrClient, SonarrClient } from './arr.js';

export class RemoveError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'RemoveError';
  }
}

export interface RemoveServiceOptions {
  prisma: PrismaClient;
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  /** The scan afterwards; without it the next scheduled scan drops what is gone. */
  scanQueue?: Pick<ScanQueue, 'request'>;
  log?: { info: (obj: object, msg: string) => void };
}

interface File {
  id: string;
  path: string;
  size: bigint;
}

/** What a target is, in CineVault and in Radarr or Sonarr. */
interface Plan {
  target: RemoveTarget;
  service: 'radarr' | 'sonarr';
  label: string;
  libraryId: string;
  itemType: 'MOVIE' | 'SHOW';
  tmdbId: number | null;
  files: File[];
  /** Radarr's movie or Sonarr's series. */
  arrId: number;
  /** Season or episode: Sonarr's files that are ours. */
  episodeFiles: EpisodeFileRecord[];
  unknownFiles: number;
}

/** "D:\Series\Show" and "/tv/Show" alike: "/"-separated, lower case. */
function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function baseName(path: string): string {
  const parts = norm(path).split('/');
  return parts[parts.length - 1] ?? '';
}

export class RemoveService {
  constructor(private readonly options: RemoveServiceOptions) {}

  async preview(itemId: string, target: RemoveTarget): Promise<RemovePreview> {
    const plan = await this.plan(itemId, target);
    return {
      ...plan.target,
      service: plan.service,
      label: plan.label,
      files: plan.files.length - plan.unknownFiles,
      sizeBytes: Number(plan.files.reduce((sum, f) => sum + f.size, 0n)),
      unknownFiles: plan.unknownFiles,
    };
  }

  async remove(itemId: string, target: RemoveTarget, by: string): Promise<RemoveResult> {
    const plan = await this.plan(itemId, target);
    const { prisma, radarr, sonarr } = this.options;
    let removedFiles: number;
    if (plan.target.scope === 'title') {
      if (plan.service === 'radarr') await radarr?.remove(plan.arrId);
      else await sonarr?.remove(plan.arrId);
      removedFiles = plan.files.length;
      // Gone from the library: it can be asked for again later.
      if (plan.tmdbId !== null) {
        await prisma.mediaRequest.deleteMany({
          where: { kind: plan.itemType, tmdbId: plan.tmdbId },
        });
      }
    } else {
      const client = sonarr as SonarrClient;
      const fileIds = new Set(plan.episodeFiles.map((f) => f.id));
      const episodes = await client.episodes(plan.arrId);
      await client.unmonitor(
        episodes
          .filter((e) => e.episodeFileId !== undefined && fileIds.has(e.episodeFileId))
          .map((e) => e.id),
      );
      for (const id of fileIds) await client.removeEpisodeFile(id);
      removedFiles = fileIds.size;
    }
    this.options.log?.info(
      { by, label: plan.label, service: plan.service, files: removedFiles },
      'removed through Radarr/Sonarr',
    );
    this.options.scanQueue?.request([plan.libraryId]);
    return { removedFiles, scanning: Boolean(this.options.scanQueue) };
  }

  private async plan(itemId: string, target: RemoveTarget): Promise<Plan> {
    const { prisma } = this.options;
    const item = await prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: {
        files: { select: { id: true, path: true, size: true } },
        seasons: {
          include: {
            episodes: { include: { files: { select: { id: true, path: true, size: true } } } },
          },
        },
      },
    });
    if (!item) throw new RemoveError(404, 'titel niet gevonden');
    const yearText = item.year ? ` (${item.year})` : '';

    if (item.type === 'MOVIE') {
      if (target.scope !== 'title') throw new RemoveError(400, 'een film verwijder je helemaal');
      const radarr = this.options.radarr;
      if (!radarr) throw new RemoveError(409, 'Radarr is niet ingesteld (RADARR_API_KEY)');
      const movie = findTitle(await radarr.movies(), item, 'tmdbId');
      if (!movie?.id) throw new RemoveError(409, `Radarr kent ${item.title}${yearText} niet`);
      return {
        target: { scope: 'title' },
        service: 'radarr',
        label: `${item.title}${yearText}`,
        libraryId: item.libraryId,
        itemType: 'MOVIE',
        tmdbId: item.tmdbId,
        files: item.files,
        arrId: movie.id,
        episodeFiles: [],
        unknownFiles: 0,
      };
    }

    const sonarr = this.options.sonarr;
    if (!sonarr) throw new RemoveError(409, 'Sonarr is niet ingesteld (SONARR_API_KEY)');
    const series = findTitle(await sonarr.series(), item, 'tvdbId');
    if (!series?.id) throw new RemoveError(409, `Sonarr kent ${item.title} niet`);
    const allEpisodes = item.seasons.flatMap((s) => s.episodes.map((e) => ({ season: s, e })));
    const base = {
      service: 'sonarr' as const,
      libraryId: item.libraryId,
      itemType: 'SHOW' as const,
      tmdbId: item.tmdbId,
      arrId: series.id,
    };

    if (target.scope === 'title') {
      return {
        ...base,
        target: { scope: 'title' },
        label: `${item.title}${yearText}`,
        files: allEpisodes.flatMap(({ e }) => e.files),
        episodeFiles: [],
        unknownFiles: 0,
      };
    }

    let files: File[];
    let label: string;
    let clean: RemoveTarget;
    if (target.scope === 'season') {
      const season = item.seasons.find((s) => s.id === target.seasonId);
      if (!season) throw new RemoveError(404, 'seizoen niet gevonden');
      files = season.episodes.flatMap((e) => e.files);
      label = `${season.seasonNumber === 0 ? 'Specials' : `Seizoen ${season.seasonNumber}`} van ${item.title}`;
      clean = { scope: 'season', seasonId: season.id };
    } else {
      const found = allEpisodes.find(({ e }) => e.id === target.episodeId);
      if (!found) throw new RemoveError(404, 'aflevering niet gevonden');
      files = found.e.files;
      label = `${item.title}: S${found.season.seasonNumber} · A${found.e.episodeNumber}${found.e.title ? ` · ${found.e.title}` : ''}`;
      clean = { scope: 'episode', episodeId: found.e.id };
    }
    if (files.length === 0) throw new RemoveError(409, 'hier staan geen bestanden bij');

    // Sonarr's files for ours: by the path inside the show's folder, else by name.
    const theirs = await sonarr.episodeFiles(series.id);
    const prefix = `${norm(item.path)}/`;
    const matched = new Map<number, EpisodeFileRecord>();
    let unknownFiles = 0;
    for (const file of files) {
      const own = norm(file.path);
      const inside = own.startsWith(prefix) ? own.slice(prefix.length) : own;
      const match =
        theirs.find((t) => t.relativePath && norm(t.relativePath) === inside) ??
        theirs.find((t) => t.path && baseName(t.path) === baseName(own));
      if (match) matched.set(match.id, match);
      else unknownFiles++;
    }
    if (matched.size === 0) {
      throw new RemoveError(
        409,
        `Sonarr kent deze bestanden niet. Laat Sonarr de serie eerst opnieuw scannen.`,
      );
    }
    return {
      ...base,
      target: clean,
      label,
      files,
      episodeFiles: [...matched.values()],
      unknownFiles,
    };
  }
}

/**
 * Radarr's movie or Sonarr's series for a title: by id, else by its folder's
 * name. Found by id but in another folder (a wrong match in CineVault): not
 * that one, since removing deletes its files.
 */
function findTitle(
  titles: ArrTitle[],
  item: { path: string; tmdbId: number | null; tvdbId: number | null },
  idKey: 'tmdbId' | 'tvdbId',
): ArrTitle | undefined {
  const folder = baseName(item.path);
  const sameFolder = (t: ArrTitle) => typeof t.path !== 'string' || baseName(t.path) === folder;
  const byId =
    (idKey === 'tvdbId' && item.tvdbId !== null
      ? titles.find((t) => t.tvdbId === item.tvdbId)
      : undefined) ??
    (item.tmdbId !== null ? titles.find((t) => t.tmdbId === item.tmdbId) : undefined);
  if (byId && sameFolder(byId)) return byId;
  return titles.find((t) => typeof t.path === 'string' && baseName(t.path) === folder);
}
