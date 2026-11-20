// Provider-neutral metadata, as returned by MetadataService.

export type ProviderName = 'tmdb' | 'tvmaze';
export type ItemKind = 'movie' | 'show';

export interface ExternalIds {
  tmdb?: number;
  tvmaze?: number;
  tvdb?: number;
  imdb?: string;
}

export interface SearchQuery {
  title: string;
  year?: number;
}

/** A search result, used for automatic matching and manual correction. */
export interface Candidate {
  provider: ProviderName;
  id: number;
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  posterRef?: string;
}

export interface CastMember {
  name: string;
  character?: string;
  profileRef?: string;
  order: number;
}

export interface ItemMetadata {
  provider: ProviderName;
  id: number;
  title: string;
  originalTitle?: string;
  year?: number;
  /** First release (movies) or first air date (shows), YYYY-MM-DD. */
  releaseDate?: string;
  overview?: string;
  tagline?: string;
  genres: string[];
  rating?: number;
  runtimeMinutes?: number;
  status?: string;
  posterRef?: string;
  backdropRef?: string;
  /** The title as a picture (transparent PNG), for the billboard and detail pages. */
  logoRef?: string;
  /** A YouTube video id of the trailer. */
  trailerKey?: string;
  /** TMDB ids of titles the provider recommends ("Meer zoals dit"). */
  recommended?: number[];
  /** Shows: the next episode that has not aired yet ("Binnenkort"). */
  nextEpisode?: { season: number; episode: number; title?: string; airDate: string };
  /**
   * Shows: episodes with an air date around now (the current and next season),
   * for the calendar. Also episodes without a file.
   */
  schedule?: ScheduledEpisodeMetadata[];
  /** Films: the collection it belongs to ("Harry Potter Collection"). */
  collection?: { id: number; name: string };
  /** From which age (0 for everyone), and the rating it comes from ("NL 12"). */
  ageRating?: number;
  certification?: string;
  cast: CastMember[];
  ids: ExternalIds;
}

export interface EpisodeMetadata {
  season: number;
  episode: number;
  absolute?: number;
  title?: string;
  overview?: string;
  /** YYYY-MM-DD */
  airDate?: string;
  runtimeMinutes?: number;
  stillRef?: string;
}

export interface ScheduledEpisodeMetadata {
  season: number;
  episode: number;
  title?: string;
  overview?: string;
  /** YYYY-MM-DD */
  airDate: string;
}

export interface SeasonMetadata {
  season: number;
  title?: string;
  overview?: string;
  posterRef?: string;
  /** Number of episodes the provider lists, also for seasons not fetched in detail. */
  episodeCount?: number;
  episodes: EpisodeMetadata[];
}

export interface ShowMetadata extends ItemMetadata {
  seasons: SeasonMetadata[];
}

export interface MovieProvider {
  readonly name: ProviderName;
  searchMovies(query: SearchQuery): Promise<Candidate[]>;
  getMovie(id: number): Promise<ItemMetadata | undefined>;
  /** Finds the provider's id from an IMDb id. */
  findMovie(ids: ExternalIds): Promise<number | undefined>;
}

export interface ShowProvider {
  readonly name: ProviderName;
  searchShows(query: SearchQuery): Promise<Candidate[]>;
  /**
   * Show details plus the episodes of `seasons` (all seasons when omitted).
   * Seasons the provider doesn't know are left out of the result.
   */
  getShow(id: number, seasons?: number[]): Promise<ShowMetadata | undefined>;
  /** Finds the provider's id from a TVDB or IMDb id. */
  findShow(ids: ExternalIds): Promise<number | undefined>;
}

/** A collection of films at TMDB, with its parts in the order they came out. */
export interface CollectionMetadata {
  id: number;
  name: string;
  overview?: string;
  posterRef?: string;
  backdropRef?: string;
  parts: {
    tmdbId: number;
    title: string;
    releaseDate?: string;
    year?: number;
    posterRef?: string;
  }[];
}
