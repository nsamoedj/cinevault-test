// Chooses providers: TMDB first, TVmaze as fallback for shows (CLAUDE.md).

import { alternativeTitles, pickBest } from './match.js';
import type {
  Candidate,
  ExternalIds,
  ItemKind,
  ItemMetadata,
  MovieProvider,
  ProviderName,
  SearchQuery,
  ShowMetadata,
  ShowProvider,
} from './types.js';

export interface MovieQuery extends SearchQuery {
  ids: ExternalIds;
}

export interface ShowQuery extends SearchQuery {
  ids: ExternalIds;
  /** Season numbers present on disk. */
  seasons: number[];
  /** True when some files only carry an absolute episode number. */
  needsAbsolute?: boolean;
}

export type MatchResult<T> =
  | { status: 'matched'; metadata: T; sources: ProviderName[] }
  | { status: 'unmatched'; reason: string };

export interface MetadataServiceOptions {
  tmdb?: MovieProvider & ShowProvider;
  tvmaze?: ShowProvider;
}

export class MetadataService {
  constructor(private readonly providers: MetadataServiceOptions) {}

  get hasMovieProvider(): boolean {
    return Boolean(this.providers.tmdb);
  }

  async matchMovie(query: MovieQuery): Promise<MatchResult<ItemMetadata>> {
    const { tmdb } = this.providers;
    if (!tmdb) return { status: 'unmatched', reason: 'TMDB_API_KEY is not set' };
    const id =
      (await tmdb.findMovie(query.ids)) ??
      (await this.searchAndPick(query, (q) => tmdb.searchMovies(q)))?.id;
    if (!id) return { status: 'unmatched', reason: 'no convincing TMDB result' };
    return this.fetchMovie(id);
  }

  async fetchMovie(id: number): Promise<MatchResult<ItemMetadata>> {
    const metadata = await this.providers.tmdb?.getMovie(id);
    return metadata
      ? { status: 'matched', metadata, sources: ['tmdb'] }
      : { status: 'unmatched', reason: `TMDB movie ${id} not found` };
  }

  async matchShow(query: ShowQuery): Promise<MatchResult<ShowMetadata>> {
    const { tmdb, tvmaze } = this.providers;
    if (tmdb) {
      const id =
        (await tmdb.findShow(query.ids)) ??
        (await this.searchAndPick(query, (q) => tmdb.searchShows(q)))?.id;
      if (id) return this.fetchShow('tmdb', id, query);
    }
    if (tvmaze) {
      const id =
        (await tvmaze.findShow(query.ids)) ??
        (await this.searchAndPick(query, (q) => tvmaze.searchShows(q)))?.id;
      if (id) return this.fetchShow('tvmaze', id, query);
    }
    return {
      status: 'unmatched',
      reason: tmdb || tvmaze ? 'no convincing result' : 'no metadata provider configured',
    };
  }

  /** Details for a known id; also used for manual corrections. */
  async fetchShow(
    provider: ProviderName,
    id: number,
    query: Pick<ShowQuery, 'seasons' | 'needsAbsolute' | 'title' | 'year' | 'ids'>,
  ): Promise<MatchResult<ShowMetadata>> {
    const primary = provider === 'tmdb' ? this.providers.tmdb : this.providers.tvmaze;
    if (!primary) return { status: 'unmatched', reason: `${provider} is not configured` };
    // Absolute numbers need the episode counts of every season.
    const show = await primary.getShow(id, query.needsAbsolute ? undefined : query.seasons);
    if (!show) return { status: 'unmatched', reason: `${provider} show ${id} not found` };

    const sources: ProviderName[] = [provider];
    const missing = query.seasons.filter(
      (n) => !show.seasons.some((s) => s.season === n && s.episodes.length > 0),
    );
    // Sonarr numbers seasons like TheTVDB; TMDB sometimes differs (anime).
    // TVmaze follows TheTVDB more closely, so fill the gaps from there.
    if (provider === 'tmdb' && missing.length > 0 && this.providers.tvmaze) {
      const filled = await this.fillFromTvmaze(show, query, missing);
      if (filled) sources.push('tvmaze');
    }
    assignAbsoluteNumbers(show);
    return { status: 'matched', metadata: show, sources };
  }

  /** Candidates for a manual match, from every configured provider. */
  async search(kind: ItemKind, query: SearchQuery): Promise<Candidate[]> {
    const { tmdb, tvmaze } = this.providers;
    if (kind === 'movie') return tmdb ? tmdb.searchMovies(query) : [];
    const lists = await Promise.all([
      tmdb ? tmdb.searchShows(query) : [],
      tvmaze ? tvmaze.searchShows(query) : [],
    ]);
    return lists.flat();
  }

  private async fillFromTvmaze(
    show: ShowMetadata,
    query: Pick<ShowQuery, 'title' | 'year' | 'ids'>,
    missing: number[],
  ): Promise<boolean> {
    const tvmaze = this.providers.tvmaze;
    if (!tvmaze) return false;
    const id =
      (await tvmaze.findShow({ ...query.ids, ...show.ids })) ??
      (
        await this.searchAndPick(
          { title: show.title, ...(show.year && { year: show.year }) },
          (q) => tvmaze.searchShows(q),
        )
      )?.id;
    if (!id) return false;
    const other = await tvmaze.getShow(id, missing);
    let filled = false;
    for (const season of other?.seasons ?? []) {
      if (season.episodes.length === 0) continue;
      show.seasons = show.seasons.filter((s) => s.season !== season.season);
      show.seasons.push(season);
      filled = true;
    }
    show.seasons.sort((a, b) => a.season - b.season);
    if (filled) show.ids = { ...show.ids, tvmaze: id };
    return filled;
  }

  /** Tries the title as written, then variants, until a result is convincing. */
  private async searchAndPick(
    query: SearchQuery,
    search: (q: SearchQuery) => Promise<Candidate[]>,
  ): Promise<Candidate | undefined> {
    for (const title of [query.title, ...alternativeTitles(query.title)]) {
      const q = { title, ...(query.year && { year: query.year }) };
      const best = pickBest(q, await search(q));
      if (best) return best.candidate;
    }
    return undefined;
  }
}

/**
 * Numbers episodes 1, 2, 3, … across regular seasons (not season 0), for files
 * named with absolute numbers. Stops at the first season with an unknown size.
 */
export function assignAbsoluteNumbers(show: ShowMetadata): void {
  let offset = 0;
  for (const season of [...show.seasons].sort((a, b) => a.season - b.season)) {
    if (season.season === 0) continue;
    const count = season.episodeCount ?? (season.episodes.length || undefined);
    for (const episode of season.episodes) episode.absolute = offset + episode.episode;
    if (count === undefined) return;
    offset += count;
  }
}
