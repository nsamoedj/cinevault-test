// "Ontdekken": rows of new and trending titles from TMDB to browse and ask
// for, a search over movies and shows at once, and a title's details. The
// lists change slowly, so TMDB's answers are kept for an hour; whether a
// title is here or asked for is looked up each time.
//
// The anime rows come from AniList, and a search asks AniList too (see
// anilist.ts): TMDB's lists and search miss much anime. Each AniList title is
// shown as its TMDB title, so its page and its request work as for any other.

import type {
  DiscoverCollection,
  DiscoverDetails,
  DiscoverSeasonDetails,
  DiscoverFeed,
  DiscoverPage,
  DiscoverRow,
  RequestKind,
} from '@cinevault/shared';
import { imageUrl } from '../images.js';
import type { RequestCandidate } from '../metadata/tmdb.js';
import type { CollectionMetadata } from '../metadata/types.js';
import {
  AniListError,
  animeSeason,
  mergeSearch,
  type AniListFormat,
  type AniListQuery,
  type AnimeDiscovery,
} from './anilist.js';
import { RequestError, type RequestService } from './service.js';

interface TmdbList {
  path: string;
  params?: (today: string, daysAgo: (n: number) => string) => Record<string, string | number>;
}

interface RowDefinition {
  id: string;
  title: string;
  kind: 'movie' | 'tv';
  /** A TMDB list; for an AniList row, what it falls back on when AniList can't answer. */
  tmdb?: TmdbList;
  /** An AniList list (anime), for a date (the season). */
  anilist?: (now: number) => AniListQuery;
}

const SERIES: AniListFormat[] = ['TV', 'TV_SHORT', 'ONA'];
const ALL_ANIME: AniListFormat[] = ['TV', 'TV_SHORT', 'ONA', 'MOVIE'];

/** In this order on the page. */
const ROWS: RowDefinition[] = [
  {
    id: 'movies-streaming',
    title: 'Nieuw te streamen',
    kind: 'movie',
    tmdb: {
      path: '/discover/movie',
      // Digital (4) and physical (5) releases: what Radarr can download.
      params: (today, daysAgo) => ({
        region: 'US',
        with_release_type: '4|5',
        'release_date.gte': daysAgo(90),
        'release_date.lte': today,
        'vote_count.gte': 20,
        sort_by: 'popularity.desc',
      }),
    },
  },
  {
    id: 'movies-trending',
    title: 'Trending films',
    kind: 'movie',
    tmdb: { path: '/trending/movie/week' },
  },
  {
    id: 'shows-new',
    title: 'Nieuwe series',
    kind: 'tv',
    tmdb: {
      path: '/discover/tv',
      params: (today, daysAgo) => ({
        'first_air_date.gte': daysAgo(120),
        'first_air_date.lte': today,
        'vote_count.gte': 10,
        without_genres: '16',
        sort_by: 'popularity.desc',
      }),
    },
  },
  {
    id: 'shows-trending',
    title: 'Trending series',
    kind: 'tv',
    tmdb: { path: '/trending/tv/week' },
  },
  {
    id: 'anime-new',
    title: 'Anime van dit seizoen',
    kind: 'tv',
    anilist: (now) => ({ sort: ['POPULARITY_DESC'], ...animeSeason(now), format_in: SERIES }),
    tmdb: {
      path: '/discover/tv',
      params: (today, daysAgo) => ({
        with_genres: '16',
        with_original_language: 'ja',
        'first_air_date.gte': daysAgo(180),
        'first_air_date.lte': today,
        sort_by: 'popularity.desc',
      }),
    },
  },
  {
    id: 'anime-trending',
    title: 'Trending anime',
    kind: 'tv',
    anilist: () => ({ sort: ['TRENDING_DESC'], format_in: ALL_ANIME }),
  },
  {
    id: 'movies-theaters',
    title: 'Nu in de bioscoop',
    kind: 'movie',
    tmdb: { path: '/movie/now_playing', params: () => ({ region: 'NL' }) },
  },
  {
    id: 'movies-upcoming',
    title: 'Binnenkort in de bioscoop',
    kind: 'movie',
    tmdb: { path: '/movie/upcoming', params: () => ({ region: 'NL' }) },
  },
  {
    id: 'anime-upcoming',
    title: 'Binnenkort: anime',
    kind: 'tv',
    anilist: () => ({
      sort: ['POPULARITY_DESC'],
      status: 'NOT_YET_RELEASED',
      format_in: ALL_ANIME,
    }),
  },
  { id: 'shows-airing', title: 'Nu op tv', kind: 'tv', tmdb: { path: '/tv/on_the_air' } },
  {
    id: 'anime-popular',
    title: 'Populaire anime',
    kind: 'tv',
    anilist: () => ({ sort: ['POPULARITY_DESC'], format_in: SERIES }),
    tmdb: {
      path: '/discover/tv',
      params: () => ({
        with_genres: '16',
        with_original_language: 'ja',
        'vote_count.gte': 100,
        sort_by: 'popularity.desc',
      }),
    },
  },
  {
    id: 'anime-movies',
    title: 'Anime-films',
    kind: 'movie',
    anilist: () => ({ sort: ['POPULARITY_DESC'], format_in: ['MOVIE'] }),
  },
  {
    id: 'movies-popular',
    title: 'Populaire films',
    kind: 'movie',
    tmdb: { path: '/movie/popular' },
  },
];

const CACHE_MS = 3600_000;
/** "Meer zoals dit": a row's worth. */
const SIMILAR = 20;

export interface DiscoverServiceOptions {
  requests: RequestService;
  /** AniList, for the anime rows and searches (off: TMDB's anime rows, as before). */
  anime?: AnimeDiscovery;
  now?: () => number;
  log?: { warn(obj: object, msg?: string): void };
}

export class DiscoverService {
  private readonly cache = new Map<
    string,
    { at: number; value: { results: RequestCandidate[]; totalPages: number } }
  >();
  /** A title's recommendations and a collection: they change slowly too. */
  private readonly extras = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly options: DiscoverServiceOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The rows there are: AniList's only with AniList (or a TMDB list to fall back on). */
  private rows(): RowDefinition[] {
    return ROWS.filter((row) => row.tmdb || (row.anilist && this.options.anime));
  }

  private async list(row: RowDefinition, page: number) {
    const key = `${row.id}:${page}`;
    const cached = this.cache.get(key);
    const now = this.now();
    if (cached && now - cached.at < CACHE_MS) return cached.value;
    let value: { results: RequestCandidate[]; totalPages: number } | undefined;
    const anime = this.options.anime;
    if (row.anilist && anime) {
      try {
        const found = await anime.list(row.anilist(now), page);
        value = {
          results: found.results.map(({ names: _names, ...card }) => card),
          totalPages: found.hasNextPage ? Math.min(page + 1, 500) : page,
        };
      } catch (error) {
        if (!row.tmdb) {
          throw error instanceof AniListError
            ? new RequestError(502, `AniList antwoordt niet (${error.message})`)
            : error;
        }
        this.options.log?.warn(
          { err: error, row: row.id },
          'discover: AniList failed, TMDB instead',
        );
      }
    }
    if (!value) {
      if (!row.tmdb) throw new RequestError(404, 'die rij bestaat niet');
      const { path, params } = row.tmdb;
      const day = (offset: number) =>
        new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
      value = await this.options.requests
        .tmdb()
        .discoverList(row.kind, path, params?.(day(0), day) ?? {}, page);
    }
    // Without a poster a card is just a grey box: leave those out.
    value.results = value.results.filter((r) => r.posterRef);
    this.cache.set(key, { at: now, value });
    if (this.cache.size > 300) {
      for (const [k, v] of this.cache) if (now - v.at >= CACHE_MS) this.cache.delete(k);
    }
    return value;
  }

  /** All rows, the first page of each. A row TMDB can't answer is left out. */
  async feed(): Promise<DiscoverFeed> {
    this.options.requests.tmdb();
    const rows = await Promise.all(
      this.rows().map(async (row): Promise<DiscoverRow | undefined> => {
        try {
          const { results } = await this.list(row, 1);
          if (results.length === 0) return undefined;
          return {
            id: row.id,
            title: row.title,
            kind: row.kind === 'movie' ? 'movie' : 'show',
            items: await this.options.requests.annotate(results),
          };
        } catch (error) {
          this.options.log?.warn({ err: error, row: row.id }, 'discover row failed');
          return undefined;
        }
      }),
    );
    return { rows: rows.filter((r): r is DiscoverRow => Boolean(r)) };
  }

  async row(id: string, page: number): Promise<DiscoverPage> {
    const row = this.rows().find((r) => r.id === id);
    if (!row) throw new RequestError(404, 'die rij bestaat niet');
    const { results, totalPages } = await this.list(row, page);
    return {
      id: row.id,
      title: row.title,
      items: await this.options.requests.annotate(results),
      page,
      totalPages,
    };
  }

  /** TMDB's search, and on the first page AniList's too (romaji and Japanese titles). */
  async search(q: string, page: number): Promise<DiscoverPage> {
    const anime = page === 1 ? this.options.anime : undefined;
    const [{ results, totalPages }, fromAniList] = await Promise.all([
      this.options.requests.tmdb().searchAll(q, page),
      anime?.search(q).catch((error: unknown) => {
        this.options.log?.warn({ err: error }, 'discover: AniList search failed');
        return [];
      }) ?? [],
    ]);
    const found = fromAniList.length > 0 ? mergeSearch(q, results, fromAniList) : results;
    return {
      id: 'search',
      title: `Resultaten voor “${q}”`,
      items: await this.options.requests.annotate(found),
      page,
      totalPages,
    };
  }

  /** TMDB's answer from the last hour, else a new one; a failure is no answer (the page still shows). */
  private async extra<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const now = this.now();
    const cached = this.extras.get(key);
    if (cached && now - cached.at < CACHE_MS) return cached.value as T;
    try {
      const value = await load();
      this.extras.set(key, { at: now, value });
      if (this.extras.size > 300) {
        for (const [k, v] of this.extras) if (now - v.at >= CACHE_MS) this.extras.delete(k);
      }
      return value;
    } catch (error) {
      this.options.log?.warn({ err: error, key }, 'discover extra failed');
      return undefined;
    }
  }

  /** "Meer zoals dit": TMDB's recommendations, without posterless ones. */
  private async similar(kind: 'movie' | 'tv', tmdbId: number) {
    const tmdb = this.options.requests.tmdb();
    const found = await this.extra(`similar:${kind}:${tmdbId}`, async () =>
      tmdb.recommendations ? await tmdb.recommendations(kind, tmdbId) : undefined,
    );
    const shown = (found ?? []).filter((r) => r.posterRef).slice(0, SIMILAR);
    return shown.length > 0 ? this.options.requests.annotate(shown) : undefined;
  }

  /** The film's collection, with all its films and whether they are here or asked for. */
  private async collection(id: number): Promise<DiscoverCollection | undefined> {
    const tmdb = this.options.requests.tmdb();
    const collection = await this.extra<CollectionMetadata>(`collection:${id}`, async () =>
      tmdb.collection ? await tmdb.collection(id) : undefined,
    );
    if (!collection || collection.parts.length < 2) return undefined;
    const parts = await this.options.requests.annotate(
      collection.parts.map((part) => ({
        kind: 'movie' as const,
        tmdbId: part.tmdbId,
        title: part.title,
        ...(part.year && { year: part.year }),
        ...(part.releaseDate && { releaseDate: part.releaseDate }),
        ...(part.posterRef && { posterRef: part.posterRef }),
        anime: false,
      })),
    );
    const posterUrl = imageUrl(collection.posterRef);
    const backdropUrl = imageUrl(collection.backdropRef);
    return {
      id: collection.id,
      name: collection.name,
      ...(collection.overview && { overview: collection.overview }),
      ...(posterUrl && { posterUrl }),
      ...(backdropUrl && { backdropUrl }),
      parts,
      owned: parts.filter((p) => p.itemId).length,
    };
  }

  async details(kind: RequestKind, tmdbId: number): Promise<DiscoverDetails> {
    const tmdbKind = kind === 'movie' ? 'movie' : 'tv';
    const [details, similar] = await Promise.all([
      this.options.requests.tmdb().requestDetails(tmdbKind, tmdbId),
      this.similar(tmdbKind, tmdbId),
    ]);
    if (!details) throw new RequestError(404, 'TMDB kent deze titel niet');
    const [card, collection] = await Promise.all([
      this.options.requests.annotate([details]).then((cards) => cards[0]),
      details.collection ? this.collection(details.collection.id) : undefined,
    ]);
    const cast = details.cast.map((person) => {
      const profileUrl = imageUrl(person.profileRef);
      return {
        name: person.name,
        ...(person.character && { character: person.character }),
        ...(profileUrl && { profileUrl }),
      };
    });
    const seasonList = details.seasonList
      ? await this.options.requests.seasonsHere(tmdbId, card?.itemId, details.seasonList)
      : undefined;
    return {
      ...(card as DiscoverDetails),
      cast,
      ...(seasonList && { seasonList }),
      genres: details.genres,
      ...(details.tagline && { tagline: details.tagline }),
      ...(details.runtimeMinutes && { runtimeMinutes: details.runtimeMinutes }),
      ...(details.seasons && { seasons: details.seasons }),
      ...(details.status && { status: details.status }),
      ...(details.trailerKey && { trailerKey: details.trailerKey }),
      ...(collection && { collection }),
      ...(similar && { similar }),
    };
  }

  /** A season's episodes, with what is here or asked for. */
  async season(tmdbId: number, seasonNumber: number): Promise<DiscoverSeasonDetails> {
    const season = await this.options.requests.tmdb().requestSeason(tmdbId, seasonNumber);
    if (!season || season.episodes.length === 0) {
      throw new RequestError(404, 'TMDB kent dit seizoen niet');
    }
    return this.options.requests.seasonHere(tmdbId, season);
  }
}
