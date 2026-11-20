// Collecties: films that belong together at TMDB ("Harry Potter Collection"),
// with all their parts in the order they came out, also the ones not in the
// library (to ask for). A film's collection comes with its metadata
// (MediaItem.collectionTmdbId); the collection itself is fetched once when a
// film of it is there, and weekly again (new parts get announced).
//
// On the start page: "Volgende in de reeks" (the next film after the last one
// watched) and "Collecties". A kids profile sees only the films for its age.

import type {
  CollectionDetails,
  CollectionPart,
  CollectionSummary,
  ItemSummary,
} from '@cinevault/shared';
import type { MediaItem, PrismaClient } from './generated/prisma/client.js';
import { imageUrl } from './images.js';
import { ageFilter, isKid, type Viewer } from './kids.js';
import type { CollectionMetadata } from './metadata/types.js';
import { withProgress } from './progress.js';

/** Fetched again after this long: new parts get announced. */
const REFRESH_MS = 7 * 24 * 60 * 60_000;
/** Collections fetched per round, one after the other. */
const BATCH = 40;
/** Shown as a collection from this many films in the library. */
export const MIN_OWNED = 2;

interface Logger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface CollectionSource {
  collection(id: number): Promise<CollectionMetadata | undefined>;
}

interface StoredPart {
  tmdbId: number;
  title: string;
  releaseDate?: string;
  year?: number;
  posterRef?: string;
}

interface Built {
  id: number;
  name: string;
  overview?: string;
  posterRef?: string;
  backdropRef?: string;
  /** All parts in order: TMDB's, plus films of ours it doesn't list. */
  parts: (StoredPart & { item?: MediaItem })[];
}

export class CollectionService {
  private readonly prisma: PrismaClient;
  private readonly source: CollectionSource | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => number;
  private running: Promise<number> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    prisma: PrismaClient;
    tmdb?: CollectionSource;
    log?: Logger;
    now?: () => number;
  }) {
    this.prisma = options.prisma;
    this.source = options.tmdb;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  start() {
    setTimeout(() => void this.refresh().catch(() => {}), 30_000).unref?.();
    this.timer = setInterval(() => void this.refresh().catch(() => {}), 6 * 60 * 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Fetches the collections of the films here that are not fetched yet, or a week ago. Returns how many. */
  refresh(): Promise<number> {
    this.running ??= this.fetchMissing().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async fetchMissing(): Promise<number> {
    const source = this.source;
    if (!source) return 0;
    const wanted = await this.prisma.mediaItem.findMany({
      where: { type: 'MOVIE', collectionTmdbId: { not: null } },
      select: { collectionTmdbId: true },
      distinct: ['collectionTmdbId'],
    });
    const ids = wanted.flatMap((w) => (w.collectionTmdbId ? [w.collectionTmdbId] : []));
    const known = await this.prisma.collection.findMany({
      where: { tmdbId: { in: ids } },
      select: { tmdbId: true, fetchedAt: true },
    });
    const fresh = new Set(
      known.filter((k) => this.now() - k.fetchedAt.getTime() < REFRESH_MS).map((k) => k.tmdbId),
    );
    const todo = ids.filter((id) => !fresh.has(id)).slice(0, BATCH);
    let done = 0;
    for (const id of todo) {
      try {
        const collection = await source.collection(id);
        if (!collection) continue;
        const data = {
          name: collection.name,
          overview: collection.overview ?? null,
          posterPath: collection.posterRef ?? null,
          backdropPath: collection.backdropRef ?? null,
          parts: collection.parts as unknown as object,
          fetchedAt: new Date(this.now()),
        };
        await this.prisma.collection.upsert({
          where: { tmdbId: id },
          create: { tmdbId: id, ...data },
          update: data,
        });
        done++;
      } catch (error) {
        this.log?.warn({ err: error, collection: id }, 'collections: could not fetch one');
      }
    }
    if (done > 0) this.log?.info({ collections: done }, 'collections fetched');
    return done;
  }
}

/** The collections with films here (all, or these), with their parts and our films in them. */
async function build(
  prisma: PrismaClient,
  viewer: Viewer | undefined,
  only?: number[],
): Promise<Built[]> {
  const films = await prisma.mediaItem.findMany({
    where: {
      ...ageFilter(viewer),
      type: 'MOVIE',
      collectionTmdbId: only ? { in: only } : { not: null },
    },
  });
  const ids = [...new Set(films.flatMap((f) => (f.collectionTmdbId ? [f.collectionTmdbId] : [])))];
  if (ids.length === 0) return [];
  const rows = await prisma.collection.findMany({ where: { tmdbId: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.tmdbId, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    const mine = films.filter((f) => f.collectionTmdbId === id);
    const stored = (Array.isArray(row?.parts) ? row.parts : []) as unknown as StoredPart[];
    const byTmdb = new Map(mine.flatMap((f) => (f.tmdbId ? [[f.tmdbId, f] as const] : [])));
    const parts: Built['parts'] = stored.map((p) => {
      const item = byTmdb.get(p.tmdbId);
      return item ? { ...p, item } : p;
    });
    // Films of ours TMDB doesn't list (or the collection isn't fetched yet): in their place by date.
    for (const film of mine) {
      if (stored.some((p) => p.tmdbId === film.tmdbId)) continue;
      const releaseDate = film.releaseDate?.toISOString().slice(0, 10);
      parts.push({
        tmdbId: film.tmdbId ?? 0,
        title: film.title,
        ...(releaseDate && { releaseDate }),
        ...(film.year && { year: film.year }),
        ...(film.posterPath && { posterRef: film.posterPath }),
        item: film,
      });
    }
    parts.sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999'));
    const first = mine[0];
    return {
      id,
      name: row?.name ?? first?.collectionName ?? 'Collectie',
      ...(row?.overview && { overview: row.overview }),
      ...((row?.posterPath ?? first?.posterPath) && {
        posterRef: (row?.posterPath ?? first?.posterPath) as string,
      }),
      ...((row?.backdropPath ?? first?.backdropPath) && {
        backdropRef: (row?.backdropPath ?? first?.backdropPath) as string,
      }),
      // A kids profile: only the films here it may see (not the ones above its age, nor missing ones).
      parts: isKid(viewer) ? parts.filter((p) => p.item) : parts,
    };
  });
}

function summaryOf(collection: Built, progress: Map<string, ItemSummary>): CollectionSummary {
  const owned = collection.parts.filter((p) => p.item);
  const posterUrl = imageUrl(collection.posterRef);
  const backdropUrl = imageUrl(collection.backdropRef);
  return {
    id: collection.id,
    name: collection.name,
    ...(posterUrl && { posterUrl }),
    ...(backdropUrl && { backdropUrl }),
    owned: owned.length,
    total: collection.parts.length,
    watched: owned.filter((p) => p.item && progress.get(p.item.id)?.progress?.watched).length,
  };
}

/** The film to watch next: the first one here after the last one watched; else the first one here. */
function nextOf(collection: Built, progress: Map<string, ItemSummary>): ItemSummary | undefined {
  const owned = collection.parts.flatMap((p) => (p.item ? [progress.get(p.item.id)] : []));
  const lastWatched = owned.findLastIndex((s) => s?.progress?.watched);
  return owned.slice(lastWatched + 1).find((s) => s && !s.progress?.watched) ?? undefined;
}

async function summaries(prisma: PrismaClient, userId: string | undefined, built: Built[]) {
  const items = built.flatMap((c) => c.parts.flatMap((p) => (p.item ? [p.item] : [])));
  const list = await withProgress(prisma, userId, items);
  return new Map(list.map((s) => [s.id, s]));
}

/** "Collecties": those with at least two films here, the most complete first. */
export async function listCollections(
  prisma: PrismaClient,
  userId: string | undefined,
  viewer: Viewer | undefined,
): Promise<CollectionSummary[]> {
  const built = (await build(prisma, viewer)).filter(
    (c) => c.parts.filter((p) => p.item).length >= MIN_OWNED,
  );
  const progress = await summaries(prisma, userId, built);
  return built
    .map((c) => summaryOf(c, progress))
    .sort((a, b) => b.owned - a.owned || a.name.localeCompare(b.name));
}

/** One collection: all its parts, ours with the profile's progress, the others with whether they were asked for. */
export async function collectionDetails(
  prisma: PrismaClient,
  id: number,
  userId: string | undefined,
  viewer: Viewer | undefined,
  now = Date.now(),
): Promise<CollectionDetails | undefined> {
  const [collection] = await build(prisma, viewer, [id]);
  if (!collection) return undefined;
  const progress = await summaries(prisma, userId, [collection]);
  const missing = collection.parts.filter((p) => !p.item).map((p) => p.tmdbId);
  const requested = new Set(
    missing.length > 0
      ? (
          await prisma.mediaRequest.findMany({
            where: {
              kind: 'MOVIE',
              tmdbId: { in: missing },
              status: { in: ['PENDING', 'APPROVED'] },
            },
            select: { tmdbId: true },
          })
        ).map((r) => r.tmdbId)
      : [],
  );
  const today = new Date(now).toISOString().slice(0, 10);
  const parts: CollectionPart[] = collection.parts.map((p) => {
    const item = p.item ? progress.get(p.item.id) : undefined;
    const posterUrl = item?.posterUrl ?? imageUrl(p.posterRef);
    return {
      tmdbId: p.tmdbId,
      title: item?.title ?? p.title,
      ...(p.year && { year: p.year }),
      ...(p.releaseDate && { releaseDate: p.releaseDate }),
      ...(posterUrl && { posterUrl }),
      released: Boolean(item) || Boolean(p.releaseDate && p.releaseDate <= today),
      ...(item && { item }),
      ...(!item && requested.has(p.tmdbId) && { requested: true }),
    };
  });
  const next = nextOf(collection, progress);
  return {
    ...summaryOf(collection, progress),
    ...(collection.overview && { overview: collection.overview }),
    parts,
    ...(next && { next }),
  };
}

/** For a film's page: its collection, and how much of it is here. */
export async function itemCollection(
  prisma: PrismaClient,
  item: MediaItem,
  viewer: Viewer | undefined,
): Promise<{ id: number; name: string; owned: number; total: number } | undefined> {
  if (item.type !== 'MOVIE' || !item.collectionTmdbId) return undefined;
  const [collection] = await build(prisma, viewer, [item.collectionTmdbId]);
  if (!collection) return undefined;
  return {
    id: collection.id,
    name: collection.name,
    owned: collection.parts.filter((p) => p.item).length,
    total: collection.parts.length,
  };
}

/**
 * The start page: "Volgende in de reeks" (per collection the profile watched
 * a film of, the next one here it hasn't seen nor started; the collection
 * watched in last first), and "Collecties".
 */
export async function homeCollections(
  prisma: PrismaClient,
  userId: string | undefined,
  viewer: Viewer | undefined,
): Promise<{ next: ItemSummary[]; collections: CollectionSummary[]; covers: ItemSummary[] }> {
  const built = (await build(prisma, viewer)).filter(
    (c) => c.parts.filter((p) => p.item).length >= MIN_OWNED,
  );
  if (built.length === 0) return { next: [], collections: [], covers: [] };
  const progress = await summaries(prisma, userId, built);
  const lastSeen = new Map<number, number>();
  if (userId) {
    const ids = built.flatMap((c) => c.parts.flatMap((p) => (p.item ? [p.item.id] : [])));
    const rows = await prisma.watchProgress.findMany({
      where: { userId, completed: true, mediaFile: { mediaItemId: { in: ids } } },
      select: { updatedAt: true, mediaFile: { select: { mediaItemId: true } } },
    });
    for (const c of built) {
      const mine = new Set(c.parts.flatMap((p) => (p.item ? [p.item.id] : [])));
      for (const r of rows) {
        if (!r.mediaFile.mediaItemId || !mine.has(r.mediaFile.mediaItemId)) continue;
        lastSeen.set(c.id, Math.max(lastSeen.get(c.id) ?? 0, r.updatedAt.getTime()));
      }
    }
  }
  const next = built
    .filter((c) => lastSeen.has(c.id))
    .sort((a, b) => (lastSeen.get(b.id) ?? 0) - (lastSeen.get(a.id) ?? 0))
    .flatMap((c) => {
      const film = nextOf(c, progress);
      // Started already: that is in "Verder kijken".
      return film && !film.progress?.fraction ? [film] : [];
    });
  const collections = built
    .map((c) => summaryOf(c, progress))
    .sort((a, b) => b.owned - a.owned || a.name.localeCompare(b.name));
  // For older apps, which show a row as posters: a film of each collection.
  const covers = collections.flatMap((s) => {
    const c = built.find((b) => b.id === s.id);
    const film =
      c && (nextOf(c, progress) ?? progress.get(c.parts.find((p) => p.item)?.item?.id ?? ''));
    return film ? [film] : [];
  });
  return { next, collections, covers };
}
