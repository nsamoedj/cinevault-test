// Writes provider metadata onto items, seasons and episodes.

import { isLatinScript } from '@cinevault/shared';
import type { MediaItem, Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { MatchResult } from '../metadata/service.js';
import type { ItemMetadata, ShowMetadata } from '../metadata/types.js';
import { parseEpisode, parseItemName } from './parse.js';

/** Lower-case title without a leading article, for sorting. */
export function sortTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an|de|het|een)\s+/, '')
    .trim();
}

/** A provider title that can be shown: titles are English (CLAUDE.md), so Latin script. */
function englishTitle(title: string | undefined): string | undefined {
  return title && isLatinScript(title) ? title : undefined;
}

/**
 * The provider's title, or the folder name when the provider only knows the
 * title in another script (Japanese, Chinese, Hindi…). Radarr and Sonarr name
 * folders in English.
 */
function itemTitle(metadata: ItemMetadata, itemPath: string): string {
  const english = englishTitle(metadata.title);
  if (english) return english;
  const folder = parseItemName(itemPath.split('/').at(-1) ?? itemPath).title;
  return isLatinScript(folder) ? folder : metadata.title;
}

export interface LocalArtwork {
  posterRef?: string;
  backdropRef?: string;
}

function itemFields(
  item: Pick<MediaItem, 'path'>,
  metadata: ItemMetadata,
  sources: string[],
  local: LocalArtwork,
): Prisma.MediaItemUpdateInput {
  const title = itemTitle(metadata, item.path);
  return {
    title,
    sortTitle: sortTitle(title),
    originalTitle: metadata.originalTitle ?? null,
    year: metadata.year ?? null,
    releaseDate: metadata.releaseDate ? new Date(`${metadata.releaseDate}T00:00:00Z`) : null,
    overview: metadata.overview ?? null,
    tagline: metadata.tagline ?? null,
    genres: metadata.genres,
    rating: metadata.rating ?? null,
    runtimeMinutes: metadata.runtimeMinutes ?? null,
    status: metadata.status ?? null,
    cast: metadata.cast as unknown as Prisma.InputJsonValue,
    // The owner's own artwork goes before provider images (CLAUDE.md).
    posterPath: local.posterRef ?? metadata.posterRef ?? null,
    backdropPath: local.backdropRef ?? metadata.backdropRef ?? null,
    logoPath: metadata.logoRef ?? null,
    ageRating: metadata.ageRating ?? null,
    certification: metadata.certification ?? null,
    trailerKey: metadata.trailerKey ?? null,
    recommendedTmdbIds: metadata.recommended ?? [],
    collectionTmdbId: metadata.collection?.id ?? null,
    collectionName: metadata.collection?.name ?? null,
    nextEpisodeSeason: metadata.nextEpisode?.season ?? null,
    nextEpisodeNumber: metadata.nextEpisode?.episode ?? null,
    nextEpisodeTitle: metadata.nextEpisode?.title ?? null,
    nextEpisodeAirDate: metadata.nextEpisode
      ? new Date(`${metadata.nextEpisode.airDate}T00:00:00Z`)
      : null,
    tmdbId: metadata.ids.tmdb ?? null,
    tvmazeId: metadata.ids.tvmaze ?? null,
    tvdbId: metadata.ids.tvdb ?? null,
    imdbId: metadata.ids.imdb ?? null,
    metadataStatus: 'MATCHED',
    metadataProvider: sources.join('+'),
    metadataUpdatedAt: new Date(),
    metadataError: null,
  };
}

export async function applyUnmatched(
  prisma: PrismaClient,
  item: Pick<MediaItem, 'id'>,
  result: Extract<MatchResult<unknown>, { status: 'unmatched' }>,
): Promise<void> {
  await prisma.mediaItem.update({
    where: { id: item.id },
    data: {
      metadataStatus: 'UNMATCHED',
      metadataError: result.reason,
      metadataUpdatedAt: new Date(),
    },
  });
}

export async function applyFailed(
  prisma: PrismaClient,
  item: Pick<MediaItem, 'id'>,
  error: unknown,
) {
  await prisma.mediaItem.update({
    where: { id: item.id },
    data: {
      metadataStatus: 'FAILED',
      metadataError: error instanceof Error ? error.message : String(error),
      metadataUpdatedAt: new Date(),
    },
  });
}

export async function applyMovie(
  prisma: PrismaClient,
  item: Pick<MediaItem, 'id' | 'path'>,
  metadata: ItemMetadata,
  sources: string[],
  local: LocalArtwork,
): Promise<void> {
  await prisma.mediaItem.update({
    where: { id: item.id },
    data: itemFields(item, metadata, sources, local),
  });
}

export async function applyShow(
  prisma: PrismaClient,
  item: Pick<MediaItem, 'id' | 'path'>,
  metadata: ShowMetadata,
  sources: string[],
  local: LocalArtwork,
): Promise<void> {
  await prisma.mediaItem.update({
    where: { id: item.id },
    data: itemFields(item, metadata, sources, local),
  });
  await applySchedule(prisma, item.id, metadata);

  // Files named with only an absolute number were filed as season 1 / episode N;
  // move them to the real season and episode now that the numbering is known.
  const absoluteOnly = await prisma.episode.findMany({
    where: { season: { mediaItemId: item.id }, absoluteNumber: { not: null } },
    include: { season: true, files: { select: { id: true } } },
  });
  for (const episode of absoluteOnly) {
    const target = metadata.seasons
      .flatMap((s) => s.episodes)
      .find((e) => e.absolute === episode.absoluteNumber);
    if (!target) continue;
    if (target.season === episode.season.seasonNumber && target.episode === episode.episodeNumber) {
      continue;
    }
    const season = await prisma.season.upsert({
      where: { mediaItemId_seasonNumber: { mediaItemId: item.id, seasonNumber: target.season } },
      create: { mediaItemId: item.id, seasonNumber: target.season },
      update: {},
    });
    const moved = await prisma.episode.upsert({
      where: { seasonId_episodeNumber: { seasonId: season.id, episodeNumber: target.episode } },
      create: {
        seasonId: season.id,
        episodeNumber: target.episode,
        absoluteNumber: episode.absoluteNumber,
      },
      update: { absoluteNumber: episode.absoluteNumber },
    });
    await prisma.mediaFile.updateMany({
      where: { id: { in: episode.files.map((f) => f.id) } },
      data: { episodeId: moved.id },
    });
    await prisma.episode.delete({ where: { id: episode.id } });
  }
  if (absoluteOnly.length > 0) {
    await prisma.season.deleteMany({ where: { mediaItemId: item.id, episodes: { none: {} } } });
  }

  const seasons = await prisma.season.findMany({
    where: { mediaItemId: item.id },
    include: { episodes: { include: { files: { select: { path: true } } } } },
  });
  for (const season of seasons) {
    const meta = metadata.seasons.find((s) => s.season === season.seasonNumber);
    if (!meta) continue;
    await prisma.season.update({
      where: { id: season.id },
      data: {
        title: meta.title ?? null,
        overview: meta.overview ?? null,
        posterPath: meta.posterRef ?? null,
      },
    });
    for (const episode of season.episodes) {
      const e = meta.episodes.find((x) => x.episode === episode.episodeNumber);
      if (!e) continue;
      await prisma.episode.update({
        where: { id: episode.id },
        data: {
          // Without an English title from the provider, use the one in the file name.
          title: englishTitle(e.title) ?? fileEpisodeTitle(episode.files) ?? null,
          overview: e.overview ?? null,
          airDate: e.airDate ? new Date(`${e.airDate}T00:00:00Z`) : null,
          runtimeMinutes: e.runtimeMinutes ?? null,
          stillPath: e.stillRef ?? null,
        },
      });
    }
  }
}

/** The calendar keeps the last month and the coming year. */
const SCHEDULE_PAST_DAYS = 30;
const SCHEDULE_FUTURE_DAYS = 365;

/** Replaces the show's air dates for the calendar ("Agenda"). */
export async function applySchedule(
  prisma: PrismaClient,
  itemId: string,
  metadata: Pick<ShowMetadata, 'schedule' | 'nextEpisode'>,
  now = Date.now(),
): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  const from = new Date(now - SCHEDULE_PAST_DAYS * day).toISOString().slice(0, 10);
  const until = new Date(now + SCHEDULE_FUTURE_DAYS * day).toISOString().slice(0, 10);
  const byKey = new Map<string, NonNullable<ShowMetadata['schedule']>[number]>();
  for (const e of [
    ...(metadata.schedule ?? []),
    ...(metadata.nextEpisode ? [metadata.nextEpisode] : []),
  ]) {
    if (e.season <= 0 || e.airDate < from || e.airDate > until) continue;
    const key = `${e.season}x${e.episode}`;
    if (!byKey.has(key)) byKey.set(key, e);
  }
  await prisma.$transaction([
    prisma.scheduledEpisode.deleteMany({ where: { mediaItemId: itemId } }),
    prisma.scheduledEpisode.createMany({
      data: [...byKey.values()].map((e) => ({
        mediaItemId: itemId,
        seasonNumber: e.season,
        episodeNumber: e.episode,
        title: englishTitle(e.title) ?? null,
        overview: 'overview' in e ? (e.overview ?? null) : null,
        airDate: new Date(`${e.airDate}T00:00:00Z`),
      })),
    }),
  ]);
}

function fileEpisodeTitle(files: { path: string }[]): string | undefined {
  for (const file of files) {
    const parsed = parseEpisode(file.path.split('/').at(-1) ?? file.path);
    if (parsed.kind === 'episode' && parsed.episodeTitle) return parsed.episodeTitle;
  }
  return undefined;
}
