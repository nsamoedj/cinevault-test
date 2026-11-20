// TMDB (themoviedb.org) API v3. Primary metadata source.
// Free for non-commercial use; the UI must show the TMDB attribution.

import { pickAgeRating } from './age.js';
import { createJsonClient, createLimiter, type FetchFn, type JsonClient } from './http.js';
import type {
  CollectionMetadata,
  Candidate,
  CastMember,
  EpisodeMetadata,
  ExternalIds,
  ItemMetadata,
  MovieProvider,
  SearchQuery,
  ScheduledEpisodeMetadata,
  SeasonMetadata,
  ShowMetadata,
  ShowProvider,
} from './types.js';

const API = 'https://api.themoviedb.org/3';
const CAST_LIMIT = 15;
/** Searches, titles and posters are English; descriptions follow the configured language. */
const ENGLISH = 'en-US';
/** English posters first, then ones without text (TMDB's "null" language). */
const IMAGE_LANGUAGES = 'en,null';

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  original_language?: string;
  genre_ids?: number[];
}

/** A title to ask for (Verzoeken, Ontdekken): what a card shows, and whether it is anime. */
export interface RequestCandidate {
  kind: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year?: number;
  /** YYYY-MM-DD: the release, or a show's first episode. */
  releaseDate?: string;
  overview?: string;
  posterRef?: string;
  backdropRef?: string;
  rating?: number;
  /** Japanese animation, which Sonarr files as anime. */
  anime: boolean;
}

/** A title's page in "Ontdekken". */
export interface RequestDetails extends RequestCandidate {
  genres: string[];
  tagline?: string;
  runtimeMinutes?: number;
  /** Shows: how many seasons there are. */
  seasons?: number;
  status?: string;
  trailerKey?: string;
  /** The actors, leading ones first (profileRef: an image ref). */
  cast: CastMember[];
  /** Shows: the seasons without specials. */
  seasonList?: RequestSeason[];
  /** Films: the collection it is part of ("Harry Potter Collection"). */
  collection?: { id: number; name: string };
}

export interface RequestSeason {
  seasonNumber: number;
  name?: string;
  episodeCount: number;
  airDate?: string;
  posterRef?: string;
}

/** A season's episodes, to ask for some of them (TMDB's numbering). */
export interface RequestSeasonDetails {
  seasonNumber: number;
  name?: string;
  episodes: {
    seasonNumber: number;
    episodeNumber: number;
    title?: string;
    airDate?: string;
    overview?: string;
    stillRef?: string;
  }[];
}

/** TMDB's genre "Animation". */
const ANIMATION = 16;

interface TmdbImage {
  file_path: string;
  iso_639_1?: string | null;
}

interface TmdbCredits {
  cast?: { name: string; character?: string; profile_path?: string | null; order?: number }[];
}

interface TmdbMovie extends TmdbSearchResult {
  release_dates?: {
    results?: { iso_3166_1: string; release_dates?: { certification?: string }[] }[];
  };
  tagline?: string;
  genres?: { id?: number; name: string }[];
  vote_average?: number;
  runtime?: number | null;
  status?: string;
  backdrop_path?: string | null;
  imdb_id?: string | null;
  credits?: TmdbCredits;
  images?: { posters?: TmdbImage[]; logos?: TmdbImage[] };
  videos?: {
    results?: {
      key: string;
      site?: string;
      type?: string;
      official?: boolean;
      iso_639_1?: string | null;
    }[];
  };
  recommendations?: { results?: { id: number }[] };
  /** Films: the series it belongs to ("Harry Potter Collection"). */
  belongs_to_collection?: { id: number; name?: string | null } | null;
  next_episode_to_air?: TmdbEpisodeRef | null;
  last_episode_to_air?: TmdbEpisodeRef | null;
}

interface TmdbEpisodeRef {
  air_date?: string | null;
  season_number: number;
  episode_number: number;
  name?: string | null;
}

interface TmdbShow extends TmdbMovie {
  content_ratings?: { results?: { iso_3166_1: string; rating?: string }[] };
  episode_run_time?: number[];
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
  seasons?: {
    season_number: number;
    name?: string;
    overview?: string;
    poster_path?: string | null;
    episode_count?: number;
  }[];
}

interface TmdbSeason {
  season_number: number;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  episodes?: {
    season_number: number;
    episode_number: number;
    name?: string;
    overview?: string;
    air_date?: string | null;
    runtime?: number | null;
    still_path?: string | null;
  }[];
}

interface TmdbFind {
  movie_results?: { id: number }[];
  tv_results?: { id: number }[];
}

/** "/abc.jpg" → "tmdb:w500/abc.jpg" (served by the image cache). */
export function tmdbImage(path: string | null | undefined, size: string): string | undefined {
  return path ? `tmdb:${size}${path}` : undefined;
}

/** An English poster, else one without text; TMDB lists the best first. */
function englishPoster(images: TmdbMovie['images']): string | null | undefined {
  const posters = images?.posters ?? [];
  return (
    posters.find((p) => p.iso_639_1 === 'en')?.file_path ??
    posters.find((p) => !p.iso_639_1)?.file_path
  );
}

/** The title as a picture: English, else without text; a PNG (an SVG would need its own renderer). */
function logo(images: TmdbMovie['images']): string | undefined {
  const logos = (images?.logos ?? []).filter((l) => l.file_path.endsWith('.png'));
  const path =
    logos.find((l) => l.iso_639_1 === 'en')?.file_path ??
    logos.find((l) => !l.iso_639_1)?.file_path;
  return tmdbImage(path, 'w500');
}

/** The trailer on YouTube: an official trailer first, then any trailer, then a teaser. */
function trailer(videos: TmdbMovie['videos']): string | undefined {
  const youtube = (videos?.results ?? []).filter((v) => v.site === 'YouTube' && v.key);
  const pick =
    youtube.find((v) => v.type === 'Trailer' && v.official) ??
    youtube.find((v) => v.type === 'Trailer') ??
    youtube.find((v) => v.type === 'Teaser');
  return pick?.key;
}

/** TMDB fills missing episode names with "Episode 5" (or "Aflevering 5" in Dutch). */
const PLACEHOLDER = /^(episode|aflevering|season|seizoen|specials?)\s*\d*$/i;

function realName(name: string | null | undefined): string | undefined {
  const value = text(name);
  return value && !PLACEHOLDER.test(value) ? value : undefined;
}

/**
 * Details in the configured language, with the English title, tagline fallback,
 * overview fallback and poster from the English version.
 */
function withEnglish<T extends TmdbMovie>(local: T, english: T | undefined): T {
  if (!english) return local;
  return {
    ...local,
    ...(text(english.title) && { title: english.title }),
    ...(text(english.name) && { name: english.name }),
    overview: text(local.overview) ?? english.overview,
    tagline: text(local.tagline) ?? english.tagline,
    poster_path: englishPoster(english.images) ?? english.poster_path ?? local.poster_path,
    // Logos, trailers and the next episode's title come from the English version.
    images: english.images ?? local.images,
    videos: english.videos ?? local.videos,
    next_episode_to_air: english.next_episode_to_air ?? local.next_episode_to_air,
    last_episode_to_air: english.last_episode_to_air ?? local.last_episode_to_air,
    // The name of the collection in English, like the titles.
    belongs_to_collection: english.belongs_to_collection ?? local.belongs_to_collection,
  };
}

/** A full date, YYYY-MM-DD, or nothing. */
function dateOf(date: string | null | undefined): string | undefined {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) && yearOf(date) ? date : undefined;
}

function yearOf(date: string | null | undefined): number | undefined {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : undefined;
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cast(credits: TmdbCredits | undefined): CastMember[] {
  return (credits?.cast ?? []).slice(0, CAST_LIMIT).map((person, i) => ({
    name: person.name,
    ...(text(person.character) && { character: text(person.character) }),
    ...(tmdbImage(person.profile_path, 'w185') && {
      profileRef: tmdbImage(person.profile_path, 'w185'),
    }),
    order: person.order ?? i,
  }));
}

function candidate(result: TmdbSearchResult): Candidate {
  const title = result.title ?? result.name ?? '';
  const originalTitle = result.original_title ?? result.original_name;
  const year = yearOf(result.release_date ?? result.first_air_date);
  return {
    provider: 'tmdb',
    id: result.id,
    title,
    ...(originalTitle && originalTitle !== title && { originalTitle }),
    ...(year && { year }),
    ...(text(result.overview) && { overview: text(result.overview) }),
    ...(tmdbImage(result.poster_path, 'w342') && {
      posterRef: tmdbImage(result.poster_path, 'w342'),
    }),
  };
}

function baseItem(item: TmdbMovie): Omit<ItemMetadata, 'ids' | 'runtimeMinutes'> {
  const year = yearOf(item.release_date ?? item.first_air_date);
  const releaseDate = dateOf(item.release_date ?? item.first_air_date);
  const originalTitle = item.original_title ?? item.original_name;
  const title = item.title ?? item.name ?? '';
  return {
    provider: 'tmdb',
    id: item.id,
    title,
    ...(originalTitle && originalTitle !== title && { originalTitle }),
    ...(year && { year }),
    ...(releaseDate && { releaseDate }),
    ...(text(item.overview) && { overview: text(item.overview) }),
    ...(text(item.tagline) && { tagline: text(item.tagline) }),
    genres: (item.genres ?? []).map((g) => g.name),
    ...(item.vote_average && { rating: item.vote_average }),
    ...(text(item.status) && { status: text(item.status) }),
    ...(tmdbImage(item.poster_path, 'w500') && { posterRef: tmdbImage(item.poster_path, 'w500') }),
    ...(tmdbImage(item.backdrop_path, 'w1280') && {
      backdropRef: tmdbImage(item.backdrop_path, 'w1280'),
    }),
    ...(logo(item.images) && { logoRef: logo(item.images) }),
    ...(trailer(item.videos) && { trailerKey: trailer(item.videos) }),
    ...((item.recommendations?.results?.length ?? 0) > 0 && {
      recommended: (item.recommendations?.results ?? []).slice(0, 40).map((r) => r.id),
    }),
    cast: cast(item.credits),
  };
}

export interface TmdbOptions {
  /** v3 API key, or a v4 read access token (starts with "eyJ"). */
  apiKey: string;
  /**
   * Language for descriptions and genres, e.g. "nl-NL"; empty texts fall back
   * to English. Titles and posters are always English (owner's choice), and so
   * are searches: Radarr/Sonarr name folders in English, so matching compares
   * against English titles.
   */
  language?: string;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export class TmdbProvider implements MovieProvider, ShowProvider {
  readonly name = 'tmdb' as const;
  private readonly get: JsonClient;
  private readonly language: string;
  private readonly authQuery: string;

  constructor(options: TmdbOptions) {
    const bearer = options.apiKey.startsWith('eyJ');
    this.authQuery = bearer ? '' : `api_key=${encodeURIComponent(options.apiKey)}`;
    this.language = options.language ?? 'en-US';
    this.get = createJsonClient({
      // TMDB allows ~50 requests/s; stay well below.
      limiter: createLimiter({ minIntervalMs: 50, concurrency: 4 }),
      ...(bearer && { headers: { Authorization: `Bearer ${options.apiKey}` } }),
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.sleep && { sleep: options.sleep }),
    });
  }

  private url(
    path: string,
    params: Record<string, string | number | undefined> = {},
    language = this.language,
  ) {
    const query = new URLSearchParams();
    query.set('language', language);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return `${API}${path}?${[this.authQuery, query.toString()].filter(Boolean).join('&')}`;
  }

  /** Movie or show details; `append` adds e.g. credits to the request. */
  private async details<T extends TmdbMovie>(path: string, append: string): Promise<T | undefined> {
    const images = { include_image_language: IMAGE_LANGUAGES };
    if (this.language === ENGLISH) {
      const english = await this.get<T>(
        this.url(path, {
          append_to_response: `${append},recommendations,images,videos`,
          ...images,
        }),
      );
      return english && withEnglish(english, english);
    }
    const [local, english] = await Promise.all([
      this.get<T>(this.url(path, { append_to_response: `${append},recommendations` })),
      this.get<T>(this.url(path, { append_to_response: 'images,videos', ...images }, ENGLISH)),
    ]);
    return local && withEnglish(local, english);
  }

  async searchMovies(query: SearchQuery): Promise<Candidate[]> {
    const data = await this.get<{ results?: TmdbSearchResult[] }>(
      this.url('/search/movie', { query: query.title, primary_release_year: query.year }, ENGLISH),
    );
    let results = data?.results ?? [];
    // primary_release_year misses films whose first release was a year earlier.
    if (results.length === 0 && query.year) {
      const retry = await this.get<{ results?: TmdbSearchResult[] }>(
        this.url('/search/movie', { query: query.title }, ENGLISH),
      );
      results = retry?.results ?? [];
    }
    return results.map(candidate);
  }

  async searchShows(query: SearchQuery): Promise<Candidate[]> {
    const data = await this.get<{ results?: TmdbSearchResult[] }>(
      this.url('/search/tv', { query: query.title, first_air_date_year: query.year }, ENGLISH),
    );
    let results = data?.results ?? [];
    if (results.length === 0 && query.year) {
      const retry = await this.get<{ results?: TmdbSearchResult[] }>(
        this.url('/search/tv', { query: query.title }, ENGLISH),
      );
      results = retry?.results ?? [];
    }
    return results.map(candidate);
  }

  /** A TMDB list or search result as something to ask for. */
  private candidate(
    kind: 'movie' | 'tv',
    r: TmdbSearchResult & { backdrop_path?: string | null; vote_average?: number },
    overview: string | undefined,
  ): RequestCandidate {
    const date = r.release_date ?? r.first_air_date;
    const year = yearOf(date);
    const releaseDate = dateOf(date);
    const posterRef = tmdbImage(r.poster_path, 'w342');
    const backdropRef = tmdbImage(r.backdrop_path, 'w1280');
    return {
      kind,
      tmdbId: r.id,
      title: r.title ?? r.name ?? '',
      ...(year && { year }),
      ...(releaseDate && { releaseDate }),
      ...(overview && { overview }),
      ...(posterRef && { posterRef }),
      ...(backdropRef && { backdropRef }),
      ...(r.vote_average && { rating: r.vote_average }),
      anime:
        kind === 'tv' && r.original_language === 'ja' && (r.genre_ids ?? []).includes(ANIMATION),
    };
  }

  /**
   * A page of a TMDB list (discover, trending, search): titles in English (as
   * everywhere), the description in the configured language.
   */
  private async listing(
    path: string,
    params: Record<string, string | number | undefined>,
    kindOf: (r: TmdbSearchResult & { media_type?: string }) => 'movie' | 'tv' | undefined,
  ): Promise<{ results: RequestCandidate[]; totalPages: number }> {
    type Page = {
      results?: (TmdbSearchResult & {
        media_type?: string;
        backdrop_path?: string | null;
        vote_average?: number;
      })[];
      total_pages?: number;
    };
    const fetchPage = (language: string) =>
      this.get<Page>(this.url(path, { include_adult: 'false', ...params }, language));
    const [english, local] = await Promise.all([
      fetchPage(ENGLISH),
      this.language === ENGLISH ? undefined : fetchPage(this.language),
    ]);
    const overviews = new Map((local?.results ?? []).map((r) => [r.id, text(r.overview)]));
    const results = (english?.results ?? []).flatMap((r) => {
      const kind = kindOf(r);
      return kind ? [this.candidate(kind, r, overviews.get(r.id) ?? text(r.overview))] : [];
    });
    // TMDB serves at most 500 pages.
    return { results, totalPages: Math.min(english?.total_pages ?? 1, 500) };
  }

  /** For requests: movies or shows matching a title. */
  async searchForRequest(kind: 'movie' | 'tv', query: string): Promise<RequestCandidate[]> {
    return (await this.listing(`/search/${kind}`, { query }, () => kind)).results.slice(0, 20);
  }

  /** "Ontdekken": movies and shows together, as TMDB ranks them. */
  async searchAll(query: string, page = 1) {
    return this.listing('/search/multi', { query, page }, (r) =>
      r.media_type === 'movie' || r.media_type === 'tv' ? r.media_type : undefined,
    );
  }

  /** "Ontdekken": a TMDB list such as /trending/movie/week or /discover/tv. */
  async discoverList(
    kind: 'movie' | 'tv',
    path: string,
    params: Record<string, string | number | undefined> = {},
    page = 1,
  ) {
    return this.listing(path, { ...params, page }, () => kind);
  }

  /** One title for a request, by id (when it was not in a search). */
  async requestCandidate(kind: 'movie' | 'tv', id: number): Promise<RequestCandidate | undefined> {
    return this.requestDetails(kind, id);
  }

  /** A title's page in "Ontdekken": the description, genres, length and trailer. */
  async requestDetails(kind: 'movie' | 'tv', id: number): Promise<RequestDetails | undefined> {
    type Details = TmdbMovie & {
      number_of_seasons?: number;
      episode_run_time?: number[];
      seasons?: (NonNullable<TmdbShow['seasons']>[number] & { air_date?: string | null })[];
    };
    const item = await this.details<Details>(`/${kind}/${id}`, 'credits');
    if (!item) return undefined;
    const base = this.candidate(
      kind,
      { ...item, genre_ids: (item.genres ?? []).flatMap((g) => (g.id ? [g.id] : [])) },
      text(item.overview),
    );
    const runtime = item.runtime ?? item.episode_run_time?.[0];
    const trailerKey = trailer(item.videos);
    const seasonList =
      kind === 'tv'
        ? (item.seasons ?? [])
            .filter((season) => season.season_number > 0)
            .map((season): RequestSeason => {
              const airDate = dateOf(season.air_date ?? undefined);
              const posterRef = tmdbImage(season.poster_path, 'w342');
              return {
                seasonNumber: season.season_number,
                ...(text(season.name) && { name: text(season.name) }),
                episodeCount: season.episode_count ?? 0,
                ...(airDate && { airDate }),
                ...(posterRef && { posterRef }),
              };
            })
        : undefined;
    return {
      ...base,
      cast: cast(item.credits),
      ...(seasonList && { seasonList }),
      genres: (item.genres ?? []).map((g) => g.name),
      ...(text(item.tagline) && { tagline: text(item.tagline) }),
      ...(runtime && { runtimeMinutes: runtime }),
      ...(item.number_of_seasons && { seasons: item.number_of_seasons }),
      ...(text(item.status) && { status: text(item.status) }),
      ...(trailerKey && { trailerKey }),
      ...(item.belongs_to_collection?.id &&
        text(item.belongs_to_collection.name) && {
          collection: {
            id: item.belongs_to_collection.id,
            name: text(item.belongs_to_collection.name) as string,
          },
        }),
    };
  }

  /**
   * "Meer zoals dit" in Ontdekken: TMDB's recommendations for a title, in
   * English with the description in the configured language, as the lists.
   */
  async recommendations(kind: 'movie' | 'tv', id: number): Promise<RequestCandidate[]> {
    return (await this.listing(`/${kind}/${id}/recommendations`, {}, () => kind)).results;
  }

  /** A season's episodes for a request: titles in English, the descriptions in the configured language. */
  async requestSeason(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<RequestSeasonDetails | undefined> {
    const path = `/tv/${tmdbId}/season/${seasonNumber}`;
    const [english, local] = await Promise.all([
      this.get<TmdbSeason>(this.url(path, {}, ENGLISH)),
      this.language === ENGLISH ? undefined : this.get<TmdbSeason>(this.url(path, {})),
    ]);
    if (!english) return undefined;
    const overviews = new Map(
      (local?.episodes ?? []).map((e) => [e.episode_number, text(e.overview)]),
    );
    return {
      seasonNumber,
      ...(text(local?.name ?? english.name) && { name: text(local?.name ?? english.name) }),
      episodes: (english.episodes ?? []).map((e) => {
        const airDate = dateOf(e.air_date ?? undefined);
        const stillRef = tmdbImage(e.still_path, 'w300');
        const overview = overviews.get(e.episode_number) ?? text(e.overview);
        return {
          seasonNumber: e.season_number,
          episodeNumber: e.episode_number,
          ...(text(e.name) && { title: text(e.name) }),
          ...(airDate && { airDate }),
          ...(overview && { overview }),
          ...(stillRef && { stillRef }),
        };
      }),
    };
  }

  /** TheTVDB's id of a show: Sonarr adds shows by it. */
  async tvdbId(tmdbId: number): Promise<number | undefined> {
    const ids = await this.get<{ tvdb_id?: number | null }>(
      this.url(`/tv/${tmdbId}/external_ids`, {}, ENGLISH),
    );
    return ids?.tvdb_id ?? undefined;
  }

  async findMovie(ids: ExternalIds): Promise<number | undefined> {
    if (ids.tmdb) return ids.tmdb;
    if (!ids.imdb) return undefined;
    const data = await this.get<TmdbFind>(
      this.url(`/find/${ids.imdb}`, { external_source: 'imdb_id' }),
    );
    return data?.movie_results?.[0]?.id;
  }

  async findShow(ids: ExternalIds): Promise<number | undefined> {
    if (ids.tmdb) return ids.tmdb;
    const lookups: [string, string][] = [];
    if (ids.tvdb) lookups.push([String(ids.tvdb), 'tvdb_id']);
    if (ids.imdb) lookups.push([ids.imdb, 'imdb_id']);
    for (const [id, source] of lookups) {
      const data = await this.get<TmdbFind>(this.url(`/find/${id}`, { external_source: source }));
      const found = data?.tv_results?.[0]?.id;
      if (found) return found;
    }
    return undefined;
  }

  async getMovie(id: number): Promise<ItemMetadata | undefined> {
    const movie = await this.details<TmdbMovie>(`/movie/${id}`, 'credits,release_dates');
    if (!movie) return undefined;
    const age = pickAgeRating(
      (movie.release_dates?.results ?? []).flatMap((r) =>
        (r.release_dates ?? []).map((d) => ({
          country: r.iso_3166_1,
          rating: d.certification ?? '',
        })),
      ),
    );
    const collection = movie.belongs_to_collection;
    return {
      ...baseItem(movie),
      ...(movie.runtime && { runtimeMinutes: movie.runtime }),
      ...(age && { ageRating: age.age, certification: age.certification }),
      ...(collection?.id &&
        text(collection.name) && {
          collection: { id: collection.id, name: text(collection.name) as string },
        }),
      ids: { tmdb: movie.id, ...(movie.imdb_id && { imdb: movie.imdb_id }) },
    };
  }

  /**
   * A collection of films ("Harry Potter Collection"): its parts in the order
   * they came out (not yet released ones last), names in English like the
   * titles, the overview in METADATA_LANGUAGE.
   */
  async collection(id: number): Promise<CollectionMetadata | undefined> {
    type TmdbCollection = {
      id: number;
      name?: string;
      overview?: string | null;
      poster_path?: string | null;
      backdrop_path?: string | null;
      parts?: {
        id: number;
        title?: string;
        release_date?: string | null;
        poster_path?: string | null;
        adult?: boolean;
      }[];
    };
    const path = `/collection/${id}`;
    const [english, local] = await Promise.all([
      this.get<TmdbCollection>(this.url(path, {}, ENGLISH)),
      this.language === ENGLISH ? undefined : this.get<TmdbCollection>(this.url(path, {})),
    ]);
    if (!english || !text(english.name)) return undefined;
    const parts = (english.parts ?? [])
      .filter((p) => !p.adult && text(p.title))
      .map((p) => {
        const releaseDate = dateOf(p.release_date);
        const posterRef = tmdbImage(p.poster_path, 'w342');
        return {
          tmdbId: p.id,
          title: text(p.title) as string,
          ...(releaseDate && { releaseDate, year: yearOf(releaseDate) as number }),
          ...(posterRef && { posterRef }),
        };
      })
      // In the order they came out; no date yet (announced) last.
      .sort((a, b) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999'));
    const overview = text(local?.overview) ?? text(english.overview);
    const posterRef = tmdbImage(english.poster_path, 'w342');
    const backdropRef = tmdbImage(english.backdrop_path, 'w1280');
    return {
      id: english.id,
      name: text(english.name) as string,
      ...(overview && { overview }),
      ...(posterRef && { posterRef }),
      ...(backdropRef && { backdropRef }),
      parts,
    };
  }

  async getShow(id: number, seasons?: number[]): Promise<ShowMetadata | undefined> {
    const show = await this.details<TmdbShow>(`/tv/${id}`, 'credits,external_ids,content_ratings');
    if (!show) return undefined;

    const known = show.seasons ?? [];
    const wanted = seasons ?? known.map((s) => s.season_number);
    // The calendar wants the season on air and the next one, with or without files.
    const airing = [
      show.last_episode_to_air?.season_number,
      show.next_episode_to_air?.season_number,
    ]
      .filter((n): n is number => n !== undefined && n > 0)
      .filter((n, i, list) => list.indexOf(n) === i);
    const toFetch = [...new Set([...wanted, ...airing])];
    const fetched = await Promise.all(
      toFetch
        .filter((n) => known.some((s) => s.season_number === n))
        .map((n) => this.getSeason(id, n)),
    );
    const details = fetched.filter((d) => d && wanted.includes(d.season));
    const schedule: ScheduledEpisodeMetadata[] = fetched
      .filter((d) => d && airing.includes(d.season))
      .flatMap((d) => d?.episodes ?? [])
      .flatMap((e) => {
        const airDate = dateOf(e.airDate);
        return airDate
          ? [
              {
                season: e.season,
                episode: e.episode,
                ...(e.title && { title: e.title }),
                ...(e.overview && { overview: e.overview }),
                airDate,
              },
            ]
          : [];
      });

    const seasonList: SeasonMetadata[] = known.map((summary) => {
      const detail = details.find((d) => d?.season === summary.season_number);
      return (
        detail ?? {
          season: summary.season_number,
          ...(realName(summary.name) && { title: realName(summary.name) }),
          ...(text(summary.overview) && { overview: text(summary.overview) }),
          ...(tmdbImage(summary.poster_path, 'w342') && {
            posterRef: tmdbImage(summary.poster_path, 'w342'),
          }),
          ...(summary.episode_count !== undefined && { episodeCount: summary.episode_count }),
          episodes: [],
        }
      );
    });
    for (const season of seasonList) {
      const summary = known.find((s) => s.season_number === season.season);
      if (summary?.episode_count !== undefined) season.episodeCount = summary.episode_count;
    }

    const runtime = show.episode_run_time?.[0];
    const tvdb = show.external_ids?.tvdb_id;
    const imdb = show.external_ids?.imdb_id;
    const next = show.next_episode_to_air;
    const nextDate = dateOf(next?.air_date);
    const age = pickAgeRating(
      (show.content_ratings?.results ?? []).map((r) => ({
        country: r.iso_3166_1,
        rating: r.rating ?? '',
      })),
    );
    return {
      ...baseItem(show),
      ...(runtime && { runtimeMinutes: runtime }),
      ...(age && { ageRating: age.age, certification: age.certification }),
      ...(next &&
        nextDate && {
          nextEpisode: {
            season: next.season_number,
            episode: next.episode_number,
            ...(realName(next.name) && { title: realName(next.name) }),
            airDate: nextDate,
          },
        }),
      ...(schedule.length > 0 && { schedule }),
      ids: { tmdb: show.id, ...(tvdb && { tvdb }), ...(imdb && { imdb }) },
      seasons: seasonList,
    };
  }

  private async getSeason(showId: number, season: number): Promise<SeasonMetadata | undefined> {
    const path = `/tv/${showId}/season/${season}`;
    const [data, english] = await Promise.all([
      this.get<TmdbSeason>(this.url(path)),
      this.language === ENGLISH ? undefined : this.get<TmdbSeason>(this.url(path, {}, ENGLISH)),
    ]);
    if (!data) return undefined;
    const en = english ?? data;

    const episodes: EpisodeMetadata[] = (data.episodes ?? []).map((e) => {
      const other = en.episodes?.find((x) => x.episode_number === e.episode_number);
      // English titles only; without one the scanner keeps the file name's title.
      const title = realName(other?.name);
      const overview = text(e.overview) ?? text(other?.overview);
      return {
        season: e.season_number,
        episode: e.episode_number,
        ...(title && { title }),
        ...(overview && { overview }),
        ...(text(e.air_date) && { airDate: text(e.air_date) }),
        ...(e.runtime && { runtimeMinutes: e.runtime }),
        ...(tmdbImage(e.still_path, 'w300') && { stillRef: tmdbImage(e.still_path, 'w300') }),
      };
    });

    return {
      season: data.season_number,
      ...(realName(en.name) && { title: realName(en.name) }),
      ...((text(data.overview) ?? text(en.overview)) && {
        overview: text(data.overview) ?? text(en.overview),
      }),
      ...(tmdbImage(en.poster_path ?? data.poster_path, 'w342') && {
        posterRef: tmdbImage(en.poster_path ?? data.poster_path, 'w342'),
      }),
      episodeCount: episodes.length,
      episodes,
    };
  }
}
