// Requests for a part of a show: some seasons, or single episodes. The
// household picks them as TMDB numbers them; Sonarr and the library number
// like TheTVDB, which differs at times (anime). The air date links them then.

import type { Prisma } from '../generated/prisma/client.js';

export interface PartEpisode {
  seasonNumber: number;
  episodeNumber: number;
  /** YYYY-MM-DD. */
  airDate?: string;
}

/** The episodes a request covers (MediaRequest.episodes); empty for a whole show. */
export function episodesOf(request: { episodes: Prisma.JsonValue | null }): PartEpisode[] {
  if (!Array.isArray(request.episodes)) return [];
  return request.episodes.flatMap((value) => {
    const e = value as Partial<PartEpisode> | null;
    if (!e || typeof e.seasonNumber !== 'number' || typeof e.episodeNumber !== 'number') return [];
    return [
      {
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        ...(typeof e.airDate === 'string' && { airDate: e.airDate }),
      },
    ];
  });
}

/** The whole show, not a part of it. */
export function isWholeShow(request: { seasons: number[]; episodes: Prisma.JsonValue | null }) {
  return request.seasons.length === 0 && episodesOf(request).length === 0;
}

const same = (a: PartEpisode, b: PartEpisode) =>
  a.seasonNumber === b.seasonNumber && a.episodeNumber === b.episodeNumber;

/**
 * The episode among `candidates` that is `wanted`: the one that aired that day
 * (several that day: the one with the same numbers), else the same numbers.
 * Specials (season 0) only by their numbers.
 */
export function matchEpisode<T extends PartEpisode>(
  wanted: PartEpisode,
  candidates: T[],
): T | undefined {
  if (wanted.airDate) {
    const thatDay = candidates.filter((c) => c.seasonNumber > 0 && c.airDate === wanted.airDate);
    if (thatDay.length === 1) return thatDay[0];
    const numbered = thatDay.find((c) => same(c, wanted));
    if (numbered) return numbered;
  }
  return candidates.find((c) => same(c, wanted));
}

/** Both lists merged, without doubles, in the show's order. */
export function mergeEpisodes(a: PartEpisode[], b: PartEpisode[]): PartEpisode[] {
  const merged = [...a];
  for (const e of b) if (!merged.some((m) => same(m, e))) merged.push(e);
  return merged.sort(
    (x, y) => x.seasonNumber - y.seasonNumber || x.episodeNumber - y.episodeNumber,
  );
}
