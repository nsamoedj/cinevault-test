// Titles like another one: the ones TMDB recommends for it that are in the
// library (same kind, in TMDB's order), then the ones sharing most genres,
// then the best rated. "Meer zoals dit" on a title's page, and the rows
// "Omdat je … keek" on the start page.

import type { MediaItem, Prisma, PrismaClient } from './generated/prisma/client.js';

export async function similarItems(
  prisma: PrismaClient,
  item: MediaItem,
  allowed: Prisma.MediaItemWhereInput,
  limit: number,
  /** Titles to leave out (besides the title itself). */
  exclude: string[] = [],
): Promise<MediaItem[]> {
  const skip = [item.id, ...exclude];
  const recommended =
    item.recommendedTmdbIds.length > 0
      ? await prisma.mediaItem.findMany({
          where: {
            ...allowed,
            type: item.type,
            tmdbId: { in: item.recommendedTmdbIds },
            id: { notIn: skip },
          },
        })
      : [];
  const rank = new Map(item.recommendedTmdbIds.map((tmdb, i) => [tmdb, i]));
  recommended.sort((a, b) => (rank.get(a.tmdbId ?? 0) ?? 0) - (rank.get(b.tmdbId ?? 0) ?? 0));
  const chosen = recommended.slice(0, limit);
  if (chosen.length < limit && item.genres.length > 0) {
    const taken = [...skip, ...chosen.map((c) => c.id)];
    const genres = new Set(item.genres);
    const sameGenre = (
      await prisma.mediaItem.findMany({
        where: {
          ...allowed,
          type: item.type,
          genres: { hasSome: item.genres },
          id: { notIn: taken },
        },
        take: 200,
      })
    )
      .map((other) => ({ other, shared: other.genres.filter((g) => genres.has(g)).length }))
      .sort(
        (a, b) =>
          b.shared - a.shared ||
          (b.other.rating ?? 0) - (a.other.rating ?? 0) ||
          a.other.sortTitle.localeCompare(b.other.sortTitle),
      );
    chosen.push(...sameGenre.slice(0, limit - chosen.length).map((s) => s.other));
  }
  return chosen;
}
