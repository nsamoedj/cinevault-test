// OpenSubtitles REST API (api.opensubtitles.com/api/v1). Needs an API key;
// without a login the download limit is small, with a free account larger
// (CLAUDE.md: check the current plans). Everything downloaded is kept in the
// cache, so each subtitle is downloaded once.

import { languageCode, languageCode1, type SubtitleSearchResult } from '@cinevault/shared';
import { createLimiter, type FetchFn, type Limiter } from '../metadata/http.js';
import type { SubtitleProvider, SubtitleQuery } from './types.js';
import { SubtitleProviderError } from './types.js';

const API = 'https://api.opensubtitles.com/api/v1';

interface SearchResponse {
  data?: {
    id: string;
    attributes: {
      language?: string;
      download_count?: number;
      hearing_impaired?: boolean;
      machine_translated?: boolean;
      ai_translated?: boolean;
      foreign_parts_only?: boolean;
      release?: string;
      moviehash_match?: boolean;
      files?: { file_id: number; file_name?: string }[];
    };
  }[];
}

export interface OpenSubtitlesOptions {
  apiKey: string;
  /** Optional account, for a higher download limit. */
  username?: string;
  password?: string;
  userAgent?: string;
  fetch?: FetchFn;
}

export class OpenSubtitlesProvider implements SubtitleProvider {
  readonly name = 'opensubtitles' as const;
  private readonly options: OpenSubtitlesOptions;
  private readonly fetchFn: FetchFn;
  // The API allows a few requests per second; stay well below.
  private readonly limiter: Limiter = createLimiter({ minIntervalMs: 250, concurrency: 1 });
  private login: Promise<{ token: string; base: string }> | undefined;

  constructor(options: OpenSubtitlesOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  private async call<T>(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    token?: string,
  ): Promise<T> {
    const response = await this.limiter.schedule(() =>
      this.fetchFn(url, {
        method,
        headers: {
          'Api-Key': this.options.apiKey,
          'User-Agent': this.options.userAgent ?? 'CineVault v0.1',
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      }),
    );
    if (!response.ok) {
      let message = `OpenSubtitles answered HTTP ${response.status}`;
      try {
        const data = (await response.json()) as { message?: string; errors?: string[] };
        message = data.message ?? data.errors?.join(', ') ?? message;
      } catch {
        // Not JSON.
      }
      if (response.status === 401 || response.status === 403) {
        message = `OpenSubtitles refused the API key or login (${message})`;
      }
      throw new SubtitleProviderError(response.status, message);
    }
    return (await response.json()) as T;
  }

  /** Logs in once when an account is set; the API may answer with its own host to use. */
  private session(): Promise<{ token: string; base: string } | undefined> {
    const { username, password } = this.options;
    if (!username || !password) return Promise.resolve(undefined);
    this.login ??= this.call<{ token: string; base_url?: string }>('POST', `${API}/login`, {
      username,
      password,
    }).then(
      (data) => ({
        token: data.token,
        base: data.base_url ? `https://${data.base_url}/api/v1` : API,
      }),
      (error: unknown) => {
        this.login = undefined;
        throw error;
      },
    );
    return this.login;
  }

  async search(query: SubtitleQuery): Promise<SubtitleSearchResult[]> {
    const params: Record<string, string> = {};
    const imdb = (id: string | undefined) => id?.replace(/^tt0*/, '');
    if (query.kind === 'episode') {
      if (query.showTmdbId) params.parent_tmdb_id = String(query.showTmdbId);
      else if (query.showImdbId) params.parent_imdb_id = imdb(query.showImdbId) ?? '';
      else params.query = query.title;
      if (query.season !== undefined) params.season_number = String(query.season);
      if (query.episode !== undefined) params.episode_number = String(query.episode);
      params.type = 'episode';
    } else {
      if (query.tmdbId) params.tmdb_id = String(query.tmdbId);
      else if (query.imdbId) params.imdb_id = imdb(query.imdbId) ?? '';
      else {
        params.query = query.title;
        if (query.year) params.year = String(query.year);
      }
      params.type = 'movie';
    }
    const languages = query.languages.map(languageCode1).filter(Boolean).sort();
    if (languages.length > 0) params.languages = languages.join(',');
    if (query.moviehash) params.moviehash = query.moviehash;
    // The API wants its parameters sorted and lower case, or it redirects.
    const search = new URLSearchParams(
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    );
    const data = await this.call<SearchResponse>('GET', `${API}/subtitles?${search}`);

    const results: SubtitleSearchResult[] = [];
    for (const item of data.data ?? []) {
      const a = item.attributes;
      const file = a.files?.[0];
      if (!file) continue;
      const language = languageCode(a.language?.split('-')[0]);
      results.push({
        id: String(file.file_id),
        provider: 'opensubtitles',
        ...(language && { language }),
        release: a.release || file.file_name || 'OpenSubtitles',
        downloads: a.download_count ?? 0,
        hearingImpaired: Boolean(a.hearing_impaired),
        matchesFile: Boolean(a.moviehash_match),
        machineTranslated: Boolean(a.machine_translated || a.ai_translated),
      });
    }
    // Made for this file first, then the most downloaded.
    return results.sort(
      (x, y) => Number(y.matchesFile) - Number(x.matchesFile) || y.downloads - x.downloads,
    );
  }

  async download(id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    const login = await this.session();
    const base = login?.base ?? API;
    const data = await this.call<{ link?: string; file_name?: string; message?: string }>(
      'POST',
      `${base}/download`,
      { file_id: Number(id), sub_format: 'srt' },
      login?.token,
    );
    if (!data.link) {
      throw new SubtitleProviderError(502, data.message ?? 'OpenSubtitles gave no download link');
    }
    const file = await this.fetchFn(data.link, { signal: AbortSignal.timeout(30_000) });
    if (!file.ok) throw new SubtitleProviderError(502, `download failed: HTTP ${file.status}`);
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: data.file_name ?? `${id}.srt`,
    };
  }
}
