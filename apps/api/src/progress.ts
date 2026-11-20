// Watch progress per profile (phase 5): where someone stopped, what they
// watched, and what to watch next.
//
// - A file counts as watched once the player passes 92% of it, or the last
//   two minutes (credits), having got there by watching: a report that jumps
//   there from much earlier (a seek, or a player that wrongly says it ended)
//   does not count. Watched stays watched; watching again only moves the
//   position.
// - "Verder kijken" lists files stopped halfway, and for shows the episode
//   after the last one finished.

import { mayWatch, type Viewer } from './kids.js';
import type {
  ContinueEntry,
  ItemDetails,
  ItemProgress,
  ItemSummary,
  ProgressDto,
} from '@cinevault/shared';
import { toItemSummary } from './dto.js';
import type { MediaItem, PrismaClient, WatchProgress } from './generated/prisma/client.js';
import { imageUrl } from './images.js';

/** Stopped this close to the end (or past this share) counts as watched. */
const WATCHED_SHARE = 0.92;
const CREDITS_MS = 2 * 60_000;
/**
 * Players report every 10 s (a background tab: about once a minute), so a
 * bigger step towards the end is not watching.
 */
const MAX_STEP_MS = 10 * 60_000;
/** Less than this is "had a look", not "watching". */
const MIN_RESUME_MS = 60_000;
/** "Verder kijken" forgets what wasn't touched for this long. */
const CONTINUE_DAYS = 90;

export function reachedEnd(
  positionMs: number,
  durationMs: number | null | undefined,
  /** Where the end credits start, when known: from there it is watched too. */
  creditsStartMs?: number | null,
): boolean {
  if (!durationMs || durationMs <= 0) return false;
  if (creditsStartMs && creditsStartMs >= durationMs / 2 && positionMs >= creditsStartMs - 5_000) {
    return true;
  }
  if (positionMs >= durationMs * WATCHED_SHARE) return true;
  return positionMs >= durationMs / 2 && durationMs - positionMs <= CREDITS_MS;
}

function toProgressDto(row: WatchProgress): ProgressDto {
  return {
    fileId: row.mediaFileId,
    positionMs: row.positionMs,
    ...(row.durationMs && { durationMs: row.durationMs }),
    watched: row.completed,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Saves where a profile is in a file (the player reports it while playing). */
export async function reportProgress(
  prisma: PrismaClient,
  userId: string,
  fileId: string,
  positionMs: number,
  durationMs?: number,
): Promise<ProgressDto | undefined> {
  const file = await prisma.mediaFile.findUnique({
    where: { id: fileId },
    select: { durationMs: true, creditsStartMs: true },
  });
  if (!file) return undefined;
  const duration = durationMs ?? file.durationMs ?? undefined;
  const previous = await prisma.watchProgress.findUnique({
    where: { userId_mediaFileId: { userId, mediaFileId: fileId } },
    select: { positionMs: true },
  });
  const ended =
    reachedEnd(positionMs, duration, file.creditsStartMs) &&
    positionMs - (previous?.positionMs ?? 0) <= MAX_STEP_MS;
  const row = await prisma.watchProgress.upsert({
    where: { userId_mediaFileId: { userId, mediaFileId: fileId } },
    create: {
      userId,
      mediaFileId: fileId,
      positionMs,
      durationMs: duration ?? null,
      completed: ended,
    },
    update: {
      positionMs,
      ...(duration && { durationMs: duration }),
      // Watched stays watched.
      ...(ended && { completed: true }),
    },
  });
  return toProgressDto(row);
}

/** Marks files watched (positions back to the start) or forgets them. */
export async function setWatched(
  prisma: PrismaClient,
  userId: string,
  fileIds: string[],
  watched: boolean,
): Promise<void> {
  if (fileIds.length === 0) return;
  await prisma.$transaction([
    prisma.watchProgress.deleteMany({ where: { userId, mediaFileId: { in: fileIds } } }),
    ...(watched
      ? [
          prisma.watchProgress.createMany({
            data: fileIds.map((mediaFileId) => ({
              userId,
              mediaFileId,
              positionMs: 0,
              completed: true,
            })),
          }),
        ]
      : []),
  ]);
}

/** Progress of a page of movies and shows, for posters (watched mark, bar). */
export async function itemProgress(
  prisma: PrismaClient,
  userId: string,
  items: MediaItem[],
): Promise<Map<string, ItemProgress>> {
  const result = new Map<string, ItemProgress>();
  const movieIds = items.filter((i) => i.type === 'MOVIE').map((i) => i.id);
  const showIds = items.filter((i) => i.type === 'SHOW').map((i) => i.id);

  if (movieIds.length > 0) {
    const rows = await prisma.watchProgress.findMany({
      where: { userId, mediaFile: { mediaItemId: { in: movieIds } } },
      orderBy: { updatedAt: 'desc' },
      include: { mediaFile: { select: { mediaItemId: true } } },
    });
    for (const row of rows) {
      const id = row.mediaFile.mediaItemId;
      if (!id) continue;
      const known = result.get(id);
      if (row.completed) {
        result.set(id, { ...known, watched: true });
        continue;
      }
      if (known?.fraction !== undefined || !row.durationMs || row.positionMs < MIN_RESUME_MS)
        continue;
      result.set(id, {
        watched: known?.watched ?? false,
        fraction: Math.min(1, row.positionMs / row.durationMs),
      });
    }
  }

  if (showIds.length > 0) {
    const episodes = await prisma.episode.findMany({
      where: { season: { mediaItemId: { in: showIds }, seasonNumber: { gt: 0 } } },
      select: {
        season: { select: { mediaItemId: true } },
        files: {
          select: { watchProgress: { where: { userId, completed: true }, select: { id: true } } },
        },
      },
    });
    const counts = new Map<string, { watched: number; total: number }>();
    for (const episode of episodes) {
      const id = episode.season.mediaItemId;
      const count = counts.get(id) ?? { watched: 0, total: 0 };
      count.total++;
      if (episode.files.some((f) => f.watchProgress.length > 0)) count.watched++;
      counts.set(id, count);
    }
    for (const [id, count] of counts) {
      if (count.watched === 0) continue;
      result.set(id, {
        watched: count.watched === count.total,
        watchedEpisodes: count.watched,
        totalEpisodes: count.total,
      });
    }
  }
  return result;
}

/** Which of these titles are in the profile's "Mijn lijst". */
async function inMyList(prisma: PrismaClient, userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.myListEntry.findMany({
    where: { userId, mediaItemId: { in: ids } },
    select: { mediaItemId: true },
  });
  return new Set(rows.map((r) => r.mediaItemId));
}

export async function withProgress(
  prisma: PrismaClient,
  userId: string | undefined,
  items: MediaItem[],
): Promise<ItemSummary[]> {
  const summaries = items.map(toItemSummary);
  if (!userId) return summaries;
  const [progress, listed] = await Promise.all([
    itemProgress(prisma, userId, items),
    inMyList(
      prisma,
      userId,
      items.map((i) => i.id),
    ),
  ]);
  return summaries.map((s) => {
    const p = progress.get(s.id);
    return { ...s, ...(p && { progress: p }), ...(listed.has(s.id) && { inMyList: true }) };
  });
}

/** Adds the profile's progress to a detail page: per episode, and the movie's resume point. */
export async function addDetailsProgress(
  prisma: PrismaClient,
  userId: string,
  item: MediaItem,
  details: ItemDetails,
): Promise<ItemDetails> {
  const fileIds = [
    ...details.files.map((f) => f.id),
    ...details.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files.map((f) => f.id))),
  ];
  const rows = await prisma.watchProgress.findMany({
    where: { userId, mediaFileId: { in: fileIds } },
    orderBy: { updatedAt: 'desc' },
  });
  const byFile = new Map(rows.map((r) => [r.mediaFileId, r]));
  /** The latest progress over a set of files; watched if any of them is. */
  const best = (ids: string[]): ProgressDto | undefined => {
    const found = ids.map((id) => byFile.get(id)).filter((r): r is WatchProgress => Boolean(r));
    if (found.length === 0) return undefined;
    const latest = found.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    )[0] as WatchProgress;
    return { ...toProgressDto(latest), watched: found.some((r) => r.completed) };
  };
  const seasons = details.seasons.map((season) => ({
    ...season,
    episodes: season.episodes.map((episode) => {
      const progress = best(episode.files.map((f) => f.id));
      return progress ? { ...episode, progress } : episode;
    }),
  }));
  const resume = best(details.files.map((f) => f.id));
  const progress = (await itemProgress(prisma, userId, [item])).get(item.id);
  const listed = (await inMyList(prisma, userId, [item.id])).has(item.id);
  return {
    ...details,
    seasons,
    ...(resume && { resume }),
    ...(progress && { progress }),
    inMyList: listed,
  };
}

type ProgressRow = WatchProgress & {
  mediaFile: {
    id: string;
    durationMs: number | null;
    mediaItem: MediaItem | null;
    episode: {
      id: string;
      episodeNumber: number;
      title: string | null;
      stillPath: string | null;
      season: { seasonNumber: number; mediaItem: MediaItem };
    } | null;
  };
};

/** The episode after `episodeId` in the show's order (no specials), with a file. */
async function nextEpisode(
  prisma: PrismaClient,
  userId: string,
  showId: string,
  episodeId: string,
) {
  const episodes = await prisma.episode.findMany({
    where: { season: { mediaItemId: showId, seasonNumber: { gt: 0 } }, files: { some: {} } },
    orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
    include: {
      season: { select: { seasonNumber: true } },
      files: {
        select: {
          id: true,
          durationMs: true,
          watchProgress: { where: { userId }, select: { completed: true } },
        },
      },
    },
  });
  const index = episodes.findIndex((e) => e.id === episodeId);
  if (index < 0) return undefined;
  // The first one after it that isn't watched yet.
  return episodes
    .slice(index + 1)
    .find((e) => !e.files.some((f) => f.watchProgress.some((p) => p.completed)));
}

export async function continueWatching(
  prisma: PrismaClient,
  userId: string,
  limit = 20,
  now = Date.now(),
  viewer?: Viewer,
): Promise<ContinueEntry[]> {
  const rows = (await prisma.watchProgress.findMany({
    where: { userId, updatedAt: { gt: new Date(now - CONTINUE_DAYS * 24 * 3600 * 1000) } },
    orderBy: { updatedAt: 'desc' },
    take: 300,
    include: {
      mediaFile: {
        select: {
          id: true,
          durationMs: true,
          mediaItem: true,
          episode: {
            select: {
              id: true,
              episodeNumber: true,
              title: true,
              stillPath: true,
              season: { select: { seasonNumber: true, mediaItem: true } },
            },
          },
        },
      },
    },
  })) as ProgressRow[];

  const entries: ContinueEntry[] = [];
  const done = new Set<string>();
  for (const row of rows) {
    if (entries.length >= limit) break;
    const episode = row.mediaFile.episode;
    const item = row.mediaFile.mediaItem ?? episode?.season.mediaItem;
    if (!item || done.has(item.id) || !mayWatch(viewer, item)) continue;
    const duration = row.durationMs ?? row.mediaFile.durationMs;
    const finished =
      reachedEnd(row.positionMs, duration) || (row.completed && row.positionMs === 0);
    const summary = toItemSummary(item);
    const backdropUrl = imageUrl(item.backdropPath);

    if (!finished && row.positionMs >= MIN_RESUME_MS) {
      done.add(item.id);
      entries.push({
        kind: 'resume',
        item: summary,
        fileId: row.mediaFileId,
        ...(episode && {
          episode: {
            id: episode.id,
            seasonNumber: episode.season.seasonNumber,
            episodeNumber: episode.episodeNumber,
            ...(episode.title && { title: episode.title }),
            ...(imageUrl(episode.stillPath) && { stillUrl: imageUrl(episode.stillPath) }),
          },
        }),
        ...(backdropUrl && { backdropUrl }),
        positionMs: row.positionMs,
        ...(duration && { durationMs: duration }),
        updatedAt: row.updatedAt.toISOString(),
      });
      continue;
    }
    if (!finished) continue; // Only had a look; an older row may say more.
    done.add(item.id);
    if (!episode) continue; // A movie that was watched to the end.
    const next = await nextEpisode(prisma, userId, item.id, episode.id);
    const file = next?.files[0];
    if (!next || !file) continue; // Caught up with the show.
    entries.push({
      kind: 'next',
      item: summary,
      fileId: file.id,
      episode: {
        id: next.id,
        seasonNumber: next.season.seasonNumber,
        episodeNumber: next.episodeNumber,
        ...(next.title && { title: next.title }),
        ...(imageUrl(next.stillPath) && { stillUrl: imageUrl(next.stillPath) }),
      },
      ...(backdropUrl && { backdropUrl }),
      positionMs: 0,
      ...(file.durationMs && { durationMs: file.durationMs }),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return entries;
}
