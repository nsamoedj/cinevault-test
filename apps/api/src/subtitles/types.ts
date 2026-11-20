// SubtitleService talks to providers through this interface, so a source can
// be replaced without changing the rest (CLAUDE.md).

import type { SubtitleSearchResult } from '@cinevault/shared';

export interface SubtitleQuery {
  kind: 'movie' | 'episode';
  title: string;
  year?: number;
  tmdbId?: number;
  imdbId?: string;
  /** For episodes: the show's ids. */
  showTmdbId?: number;
  showImdbId?: string;
  season?: number;
  episode?: number;
  /** OpenSubtitles hash of the file: finds subtitles made for exactly this release. */
  moviehash?: string;
  /** ISO 639-2, e.g. ["nld", "eng"]. */
  languages: string[];
}

export interface SubtitleProvider {
  readonly name: 'opensubtitles';
  search(query: SubtitleQuery): Promise<SubtitleSearchResult[]>;
  download(id: string): Promise<{ bytes: Uint8Array; fileName: string }>;
}

/** A provider error with the HTTP status to pass on (e.g. 406 when the daily limit is reached). */
export class SubtitleProviderError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
