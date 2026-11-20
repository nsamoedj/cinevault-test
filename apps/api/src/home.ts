// The start page: a billboard with a few titles, and rows below it: new
// episodes, recently added movies, "Omdat je … keek" (titles like what this
// profile watched lately), new releases, highly rated, the most common
// genres. "Verder kijken" comes from /continue, which is per profile.
//
// "New" is when a file arrived (MediaFile.addedAt: its mtime, so the first
// scan of an existing library still knows what came last), not when
// CineVault first saw it.

import type { FeaturedItem, HomeDto, HomeRow, ItemSummary, NewEpisodes } from '@cinevault/shared';
import type { MediaItem, Prisma, PrismaClient } from './generated/prisma/client.js';
import { ageFilter, isKid, type Viewer } from './kids.js';
import { imageUrl } from './images.js';
import { continueWatching, withProgress } from './progress.js';
import { sortLibraries } from './libraries.js';
import { itemOrder } from './routes/library.js';
import { myList } from './routes/myList.js';
import { similarItems } from './similar.js';
import { homeCollections } from './collections.js';

const ROW_SIZE = 20;
const FEATURED = 5;
const GENRE_ROWS = 6;
/** Episodes of a show that arrived within this of its newest count as one batch. */
const BATCH_MS = 7 * 86_400_000;
/** "Nieuwe releases": released (or, for a show, its newest episode aired) this recently. */
const RELEASE_DAYS = 365;
/** "Binnenkort": episodes airing within this many days. */
const UPCOMING_DAYS = 60;
/** "Omdat je … keek": this many rows, from titles watched this recently. */
const BECAUSE_ROWS = 2;
const BECAUSE_DAYS = 120;
/** A row needs this many titles; fewer is not worth a row. */
const BECAUSE_MIN = 4;
/** Watched, not just opened: finished, or at least this far. */
const BECAUSE_WATCHED_MS = 10 * 60_000;

/**
 * Shows with new episodes, the newest first: per show the episodes that came
 * in together, without the ones this profile has already watched, starting
 * from the first of them.
 */
async function newEpisodes(
  prisma: PrismaClient,
  userId: string | undefined,
  summaries: (items: MediaItem[]) => Promise<ItemSummary[]>,
  allowed: Prisma.MediaItemWhereInput,
): Promise<NewEpisodes[]> {
  const files = await prisma.mediaFile.findMany({
    where: { episode: { season: { seasonNumber: { gt: 0 } } } },
    orderBy: [{ addedAt: 'desc' }, { id: 'asc' }],
    take: 600,
    select: {
      id: true,
      addedAt: true,
      episode: {
        select: {
          episodeNumber: true,
          title: true,
          stillPath: true,
          season: { select: { seasonNumber: true, mediaItemId: true } },
        },
      },
    },
  });
  type File = (typeof files)[number];
  const batches = new Map<string, File[]>();
  for (const file of files) {
    const showId = file.episode?.season.mediaItemId;
    if (!showId) continue;
    const batch = batches.get(showId);
    if (!batch) {
      if (batches.size < ROW_SIZE * 2) batches.set(showId, [file]);
    } else if ((batch[0]?.addedAt.getTime() ?? 0) - file.addedAt.getTime() <= BATCH_MS) {
      batch.push(file);
    }
  }

  // Per episode, for this profile: watched ones drop out, a started one shows how far.
  const progress = userId
    ? await prisma.watchProgress.findMany({
        where: { userId, mediaFileId: { in: [...batches.values()].flat().map((f) => f.id) } },
        select: { mediaFileId: true, completed: true, positionMs: true, durationMs: true },
      })
    : [];
  const watched = new Set(progress.filter((p) => p.completed).map((p) => p.mediaFileId));
  const started = new Map(
    progress
      .filter((p) => !p.completed && p.positionMs > 0 && p.durationMs)
      .map((p) => [p.mediaFileId, Math.min(1, p.positionMs / (p.durationMs ?? 1))]),
  );

  const picked: { showId: string; first: File; count: number; newest: Date }[] = [];
  for (const [showId, batch] of batches) {
    // One per episode (an episode can have two files, e.g. 1080p and 4K).
    const episodes = new Map<string, File>();
    for (const file of batch) {
      const key = `${file.episode?.season.seasonNumber}x${file.episode?.episodeNumber}`;
      if (!episodes.has(key)) episodes.set(key, file);
    }
    const open = [...episodes.values()]
      .filter((f) => !watched.has(f.id))
      .sort(
        (a, b) =>
          (a.episode?.season.seasonNumber ?? 0) - (b.episode?.season.seasonNumber ?? 0) ||
          (a.episode?.episodeNumber ?? 0) - (b.episode?.episodeNumber ?? 0),
      );
    const first = open[0];
    if (!first || !batch[0]) continue;
    picked.push({ showId, first, count: open.length, newest: batch[0].addedAt });
    if (picked.length === ROW_SIZE) break;
  }

  const shows = await prisma.mediaItem.findMany({
    where: { ...allowed, id: { in: picked.map((p) => p.showId) } },
  });
  const byId = new Map((await summaries(shows)).map((s) => [s.id, s]));
  return picked.flatMap(({ showId, first, count, newest }) => {
    const item = byId.get(showId);
    const episode = first.episode;
    if (!item || !episode) return [];
    const stillUrl = imageUrl(episode.stillPath);
    const fraction = started.get(first.id);
    return [
      {
        item,
        fileId: first.id,
        seasonNumber: episode.season.seasonNumber,
        episodeNumber: episode.episodeNumber,
        ...(episode.title && { title: episode.title }),
        ...(stillUrl && { stillUrl }),
        addedAt: newest.toISOString(),
        count,
        ...(fraction !== undefined && { fraction }),
      },
    ];
  });
}

/**
 * "Omdat je … keek": per title this profile watched lately (the most recent
 * first), the titles like it (similar.ts) that it has not watched or started.
 */
async function becauseYouWatched(
  prisma: PrismaClient,
  userId: string,
  summaries: (items: MediaItem[]) => Promise<ItemSummary[]>,
  allowed: Prisma.MediaItemWhereInput,
  now: number,
): Promise<HomeRow[]> {
  const progress = await prisma.watchProgress.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      updatedAt: true,
      completed: true,
      positionMs: true,
      mediaFile: {
        select: {
          mediaItemId: true,
          episode: { select: { season: { select: { mediaItemId: true } } } },
        },
      },
    },
  });
  const itemOf = (p: (typeof progress)[number]) =>
    p.mediaFile.mediaItemId ?? p.mediaFile.episode?.season.mediaItemId;
  // Anything this profile watched or started stays out of the rows.
  const seen = new Set(progress.flatMap((p) => itemOf(p) ?? []));
  const since = now - BECAUSE_DAYS * 86_400_000;
  const seedIds: string[] = [];
  for (const p of progress) {
    const id = itemOf(p);
    if (!id || seedIds.includes(id) || p.updatedAt.getTime() < since) continue;
    if (p.completed || p.positionMs >= BECAUSE_WATCHED_MS) seedIds.push(id);
  }
  const seeds = await prisma.mediaItem.findMany({
    where: { ...allowed, id: { in: seedIds.slice(0, 10) } },
  });
  seeds.sort((a, b) => seedIds.indexOf(a.id) - seedIds.indexOf(b.id));

  const rows: HomeRow[] = [];
  const used = new Set<string>();
  for (const seed of seeds) {
    if (rows.length === BECAUSE_ROWS) break;
    const like = await similarItems(prisma, seed, allowed, ROW_SIZE, [...seen, ...used]);
    if (like.length < BECAUSE_MIN) continue;
    for (const item of like) used.add(item.id);
    rows.push({
      id: `because-${seed.id}`,
      title: `Omdat je ${seed.title} keek`,
      because: { itemId: seed.id, title: seed.title },
      items: await summaries(like),
    });
  }
  return rows;
}

/** A stable shuffle that changes once a day, so the billboard varies but doesn't jump. */
function dailyOrder<T extends { id: string }>(items: T[], now: number): T[] {
  const day = Math.floor(now / 86_400_000);
  const score = (id: string) => {
    let hash = day;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return hash;
  };
  return [...items].sort((a, b) => score(a.id) - score(b.id));
}

/** What "Afspelen" in the billboard plays: a movie's file, or the show's next episode. */
async function playTarget(
  prisma: PrismaClient,
  item: MediaItem,
  resume: Map<string, FeaturedItem['play']>,
): Promise<{ play?: FeaturedItem['play']; height?: number; hdrFormat?: string }> {
  const known = resume.get(item.id);
  if (item.type === 'MOVIE') {
    const file = await prisma.mediaFile.findFirst({
      where: { mediaItemId: item.id },
      orderBy: [{ height: { sort: 'desc', nulls: 'last' } }],
      select: { id: true, height: true, hdrFormat: true, durationMs: true },
    });
    if (!file) return {};
    const play =
      known?.fileId === file.id
        ? known
        : { fileId: file.id, ...(file.durationMs && { durationMs: file.durationMs }) };
    return {
      play,
      ...(file.height && { height: file.height }),
      ...(file.hdrFormat && { hdrFormat: file.hdrFormat }),
    };
  }
  const first = await prisma.mediaFile.findFirst({
    where: { episode: { season: { mediaItemId: item.id, seasonNumber: { gt: 0 } } } },
    orderBy: [
      { episode: { season: { seasonNumber: 'asc' } } },
      { episode: { episodeNumber: 'asc' } },
    ],
    select: {
      id: true,
      height: true,
      hdrFormat: true,
      episode: { select: { episodeNumber: true, season: { select: { seasonNumber: true } } } },
    },
  });
  if (!first) return {};
  const play = known ?? {
    fileId: first.id,
    ...(first.episode && {
      seasonNumber: first.episode.season.seasonNumber,
      episodeNumber: first.episode.episodeNumber,
    }),
  };
  return {
    play,
    ...(first.height && { height: first.height }),
    ...(first.hdrFormat && { hdrFormat: first.hdrFormat }),
  };
}

export async function homePage(
  prisma: PrismaClient,
  userId: string | undefined,
  now = Date.now(),
  viewer?: Viewer,
): Promise<HomeDto> {
  const summaries = (items: MediaItem[]) => withProgress(prisma, userId, items);
  // A kids profile: only what it may watch (kids.ts).
  const allowed = ageFilter(viewer);
  const maxAge = isKid(viewer) ? (viewer?.maxAge ?? -1) : 1000;
  const libraries = sortLibraries(await prisma.library.findMany({ orderBy: { name: 'asc' } }));

  // Billboard: recently added titles with a backdrop and a description.
  const candidates = await prisma.mediaItem.findMany({
    where: {
      ...allowed,
      backdropPath: { not: null },
      overview: { not: null },
      metadataStatus: 'MATCHED',
    },
    orderBy: itemOrder('added'),
    take: 40,
  });
  const resume = new Map<string, FeaturedItem['play']>();
  if (userId) {
    for (const entry of await continueWatching(prisma, userId, 50, now, viewer)) {
      resume.set(entry.item.id, {
        fileId: entry.fileId,
        ...(entry.positionMs > 0 && { positionMs: entry.positionMs }),
        ...(entry.durationMs && { durationMs: entry.durationMs }),
        ...(entry.episode && {
          seasonNumber: entry.episode.seasonNumber,
          episodeNumber: entry.episode.episodeNumber,
        }),
      });
    }
  }
  const picked = dailyOrder(candidates, now).slice(0, FEATURED);
  const pickedSummaries = await summaries(picked);
  const featured: FeaturedItem[] = [];
  for (const [i, item] of picked.entries()) {
    const backdropUrl = imageUrl(item.backdropPath);
    const summary = pickedSummaries[i];
    if (!backdropUrl || !summary) continue;
    const logoUrl = imageUrl(item.logoPath);
    featured.push({
      ...summary,
      backdropUrl,
      ...(logoUrl && { logoUrl }),
      genres: item.genres,
      ...(item.overview && { overview: item.overview }),
      ...(item.tagline && { tagline: item.tagline }),
      ...(item.rating && { rating: item.rating }),
      ...(item.runtimeMinutes && { runtimeMinutes: item.runtimeMinutes }),
      ...(await playTarget(prisma, item, resume)),
    });
  }

  const rows: HomeRow[] = [];
  const add = (row: Omit<HomeRow, 'items'>, items: ItemSummary[]) => {
    if (items.length > 0) rows.push({ ...row, items });
  };

  // "Mijn lijst" first: what the profile picked itself.
  if (userId) {
    add(
      { id: 'my-list', title: 'Mijn lijst' },
      (await myList(prisma, userId, viewer)).slice(0, ROW_SIZE),
    );
  }

  const series = await homeCollections(prisma, userId, viewer);
  // The next film of a series the profile is watching.
  add({ id: 'collection-next', title: 'Volgende in de reeks' }, series.next.slice(0, ROW_SIZE));

  const because = userId ? await becauseYouWatched(prisma, userId, summaries, allowed, now) : [];

  const episodes = await newEpisodes(prisma, userId, summaries, allowed);
  if (episodes.length > 0) {
    rows.push({
      id: 'new-episodes',
      title: 'Nieuwe afleveringen',
      // For older apps, which show these as posters: without the show's progress
      // bar, which is about all its episodes, not about the new ones.
      items: episodes.map((e) => {
        const item = { ...e.item };
        delete item.progress;
        return item;
      }),
      episodes,
    });
  }

  const movieLibraries = libraries.filter((l) => l.type === 'MOVIES');
  for (const library of movieLibraries) {
    const items = await prisma.mediaItem.findMany({
      where: { ...allowed, libraryId: library.id },
      orderBy: itemOrder('added'),
      take: ROW_SIZE,
    });
    add(
      {
        id: `new-${library.id}`,
        title:
          movieLibraries.length > 1
            ? `Recent toegevoegd in ${library.name}`
            : 'Recent toegevoegde films',
        libraryId: library.id,
        sort: 'added',
      },
      await summaries(items),
    );
  }

  // The first "Omdat je … keek" after what is new, the second further down.
  const firstBecause = because.shift();
  if (firstBecause) rows.push(firstBecause);

  // Movies by release date (the year when there is none yet), shows by
  // their newest episode that is here.
  const today = new Date(now).toISOString().slice(0, 10);
  const released = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM (
      SELECT i.id, CASE WHEN i.type = 'MOVIE'
        THEN coalesce(i."releaseDate", make_date(i.year, 1, 1))
        ELSE (
          SELECT max(e."airDate") FROM "Episode" e
          JOIN "Season" s ON s.id = e."seasonId"
          WHERE s."mediaItemId" = i.id AND s."seasonNumber" > 0
            AND EXISTS (SELECT 1 FROM "MediaFile" f WHERE f."episodeId" = e.id)
        ) END AS released
      FROM "MediaItem" i
      WHERE ${maxAge} >= 1000 OR i."ageRating" <= ${maxAge}
    ) t
    WHERE released <= ${today}::date AND released > ${today}::date - ${RELEASE_DAYS}::int
    ORDER BY released DESC, id
    LIMIT ${ROW_SIZE}`;
  const releasedItems = await prisma.mediaItem.findMany({
    where: { ...allowed, id: { in: released.map((r) => r.id) } },
  });
  const releaseOrder = new Map(released.map((r, i) => [r.id, i]));
  releasedItems.sort((a, b) => (releaseOrder.get(a.id) ?? 0) - (releaseOrder.get(b.id) ?? 0));
  add({ id: 'new-releases', title: 'Nieuwe releases' }, await summaries(releasedItems));

  // "Binnenkort": the next episodes of the shows here, the soonest first.
  const soon = await prisma.mediaItem.findMany({
    where: {
      ...allowed,
      type: 'SHOW',
      nextEpisodeAirDate: {
        gte: new Date(`${today}T00:00:00Z`),
        lte: new Date(Date.parse(`${today}T00:00:00Z`) + UPCOMING_DAYS * 86_400_000),
      },
      nextEpisodeSeason: { not: null },
      nextEpisodeNumber: { not: null },
    },
    orderBy: [{ nextEpisodeAirDate: 'asc' }, { sortTitle: 'asc' }],
    take: ROW_SIZE,
  });
  if (soon.length > 0) {
    const shows = await summaries(soon);
    const upcoming = soon.flatMap((show, i) => {
      const item = shows[i];
      if (!item || !show.nextEpisodeAirDate) return [];
      return [
        {
          item,
          seasonNumber: show.nextEpisodeSeason ?? 0,
          episodeNumber: show.nextEpisodeNumber ?? 0,
          ...(show.nextEpisodeTitle && { title: show.nextEpisodeTitle }),
          airDate: show.nextEpisodeAirDate.toISOString().slice(0, 10),
        },
      ];
    });
    rows.push({
      id: 'upcoming',
      title: 'Binnenkort',
      // For older apps, as posters, without the show's progress (see above).
      items: upcoming.map((u) => {
        const item = { ...u.item };
        delete item.progress;
        return item;
      }),
      upcoming,
    });
  }

  rows.push(...because);

  const rated = await prisma.mediaItem.findMany({
    where: { ...allowed, rating: { gte: 7 } },
    orderBy: itemOrder('rating'),
    take: ROW_SIZE,
  });
  add({ id: 'top-rated', title: 'Hoog gewaardeerd' }, await summaries(rated));

  if (series.collections.length > 0) {
    rows.push({
      id: 'collections',
      title: 'Collecties',
      items: series.covers.slice(0, ROW_SIZE),
      collections: series.collections.slice(0, ROW_SIZE),
    });
  }

  const genres = await prisma.$queryRaw<{ genre: string }[]>`
    SELECT genre FROM "MediaItem", unnest(genres) AS genre
    WHERE ${maxAge} >= 1000 OR "ageRating" <= ${maxAge}
    GROUP BY genre HAVING count(*) >= 3
    ORDER BY count(*) DESC, genre ASC LIMIT ${GENRE_ROWS}`;
  for (const { genre } of genres) {
    const items = await prisma.mediaItem.findMany({
      where: { ...allowed, genres: { has: genre } },
      orderBy: itemOrder('rating'),
      take: ROW_SIZE,
    });
    add({ id: `genre-${genre}`, title: genre, genre }, await summaries(dailyOrder(items, now)));
  }

  return { featured, rows };
}
