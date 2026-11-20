// AniSkip (api.aniskip.com): openings and endings of anime episodes, timed by
// its users, per MyAnimeList entry and episode. A first source for the intro
// and the credits of anime, before the fingerprints (which read the disk).
//
// MyAnimeList numbers per cour; Sonarr (and CineVault) per TheTVDB season. The
// Fribb anime-lists map one to the other: each entry has a TVDB (and TMDB)
// season and an episode offset (TVDB episode = MAL episode + offset). The list
// is kept in CACHE_DIR/aniskip and fetched again after a week.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createJsonClient,
  createLimiter,
  type FetchFn,
  type JsonClient,
} from '../metadata/http.js';

const ANISKIP_URL = 'https://api.aniskip.com';
const ANIME_LIST_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Ask again for a list that couldn't be fetched after this long. */
const LIST_RETRY_MS = 60 * 60 * 1000;

export interface Range {
  start: number;
  end: number;
}

export interface SkipTimes {
  intro?: Range;
  credits?: Range;
  /** "Previously on…": what happened before. */
  recap?: Range;
}

/** One entry of the anime-lists, as far as CineVault needs it. */
interface ListEntry {
  mal_id?: number;
  anilist_id?: number;
  tvdb_id?: number;
  themoviedb_id?: { tv?: number; movie?: number };
  season?: { tvdb?: number; tmdb?: number };
  episode_offset?: { tvdb?: number; tmdb?: number };
}

interface Cour {
  season: number;
  offset: number;
  malId: number;
}

/** Where an AniList (or MyAnimeList) entry is on TMDB and TheTVDB. */
export interface AnimeIds {
  tmdb?: { kind: 'movie' | 'tv'; id: number };
  tvdbId?: number;
}

/** The MAL entry and episode for a show's season and episode (TVDB numbering first, then TMDB). */
export class AnimeMap {
  private readonly tvdb = new Map<number, Cour[]>();
  private readonly tmdb = new Map<number, Cour[]>();
  private readonly anilist = new Map<number, AnimeIds>();
  private readonly mal = new Map<number, AnimeIds>();

  constructor(entries: ListEntry[]) {
    for (const e of entries) {
      // "Ontdekken": an AniList title to its TMDB title (a later season to its show).
      const ids: AnimeIds = {};
      const tmdbTv = e.themoviedb_id?.tv;
      const tmdbMovie = e.themoviedb_id?.movie;
      if (typeof tmdbTv === 'number') ids.tmdb = { kind: 'tv', id: tmdbTv };
      else if (typeof tmdbMovie === 'number') ids.tmdb = { kind: 'movie', id: tmdbMovie };
      if (typeof e.tvdb_id === 'number') ids.tvdbId = e.tvdb_id;
      if (ids.tmdb || ids.tvdbId) {
        if (typeof e.anilist_id === 'number' && !this.anilist.has(e.anilist_id)) {
          this.anilist.set(e.anilist_id, ids);
        }
        if (typeof e.mal_id === 'number' && !this.mal.has(e.mal_id)) this.mal.set(e.mal_id, ids);
      }
      if (typeof e.mal_id !== 'number') continue;
      const add = (index: Map<number, Cour[]>, id: unknown, season: unknown, offset: unknown) => {
        if (typeof id !== 'number' || typeof season !== 'number' || season <= 0) return;
        const list = index.get(id) ?? [];
        list.push({
          season,
          offset: typeof offset === 'number' ? offset : 0,
          malId: e.mal_id as number,
        });
        index.set(id, list);
      };
      add(this.tvdb, e.tvdb_id, e.season?.tvdb, e.episode_offset?.tvdb);
      add(this.tmdb, e.themoviedb_id?.tv, e.season?.tmdb, e.episode_offset?.tmdb);
    }
  }

  get size(): number {
    return this.tvdb.size + this.tmdb.size;
  }

  /** An AniList entry's TMDB and TVDB ids, by its AniList id, else its MyAnimeList id. */
  ids(anilistId: number, malId?: number | null): AnimeIds | undefined {
    return this.anilist.get(anilistId) ?? (malId ? this.mal.get(malId) : undefined);
  }

  /**
   * A season split in cours has an entry per cour, each with the offset where
   * it starts: the episode belongs to the last one that starts before it.
   */
  find(
    ids: { tvdbId?: number | null; tmdbId?: number | null },
    season: number,
    episode: number,
  ): { malId: number; episode: number } | undefined {
    const pick = (list: Cour[] | undefined) => {
      const cour = (list ?? [])
        .filter((c) => c.season === season && c.offset < episode)
        .sort((a, b) => b.offset - a.offset)[0];
      return cour && { malId: cour.malId, episode: episode - cour.offset };
    };
    return (
      (ids.tvdbId ? pick(this.tvdb.get(ids.tvdbId)) : undefined) ??
      (ids.tmdbId ? pick(this.tmdb.get(ids.tmdbId)) : undefined)
    );
  }

  /** The MAL entry a show starts with: its first season's first cour (TVDB numbering first). */
  first(ids: { tvdbId?: number | null; tmdbId?: number | null }): number | undefined {
    const pick = (list: Cour[] | undefined) =>
      [...(list ?? [])].sort((a, b) => a.season - b.season || a.offset - b.offset)[0]?.malId;
    return (
      (ids.tvdbId ? pick(this.tvdb.get(ids.tvdbId)) : undefined) ??
      (ids.tmdbId ? pick(this.tmdb.get(ids.tmdbId)) : undefined)
    );
  }

  /** Is this show in the anime-lists at all? */
  has(ids: { tvdbId?: number | null; tmdbId?: number | null }): boolean {
    return Boolean(
      (ids.tvdbId && this.tvdb.has(ids.tvdbId)) || (ids.tmdbId && this.tmdb.has(ids.tmdbId)),
    );
  }
}

interface AniSkipResponse {
  found?: boolean;
  results?: {
    interval?: { startTime?: number; endTime?: number };
    skipType?: string;
    episodeLength?: number;
  }[];
}

export interface AniSkipOptions {
  /** CACHE_DIR: the anime-lists are kept there. */
  cacheDir?: string;
  aniskipUrl?: string;
  animeListUrl?: string;
  fetch?: FetchFn;
  now?: () => number;
  log?: { warn: (obj: object, msg?: string) => void };
}

export class AniSkip {
  private readonly options: AniSkipOptions;
  private readonly json: JsonClient;
  private map: AnimeMap | undefined;
  private loadedAt = 0;
  private failedAt = -Infinity;
  private loading: Promise<AnimeMap | undefined> | undefined;

  constructor(options: AniSkipOptions = {}) {
    this.options = options;
    this.json = createJsonClient({
      // AniSkip is free and run by volunteers: one question at a time, gently.
      limiter: createLimiter({ minIntervalMs: 500, concurrency: 1 }),
      ...(options.fetch && { fetch: options.fetch }),
      headers: { 'User-Agent': 'CineVault (self-hosted media server)' },
      retries: 2,
      timeoutMs: 10_000,
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The anime-lists: in memory, else from the cache, else downloaded (and kept). */
  async animeMap(): Promise<AnimeMap | undefined> {
    if (this.map && this.now() - this.loadedAt < LIST_MAX_AGE_MS) return this.map;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(): Promise<AnimeMap | undefined> {
    const file =
      this.options.cacheDir && path.join(this.options.cacheDir, 'aniskip', 'anime-list.json');
    let stale: ListEntry[] | undefined;
    if (file) {
      try {
        const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
        const entries = JSON.parse(text) as ListEntry[];
        if (this.now() - info.mtimeMs < LIST_MAX_AGE_MS) return this.keep(entries);
        stale = entries;
      } catch {
        // Not downloaded yet.
      }
    }
    if (this.now() - this.failedAt < LIST_RETRY_MS) return stale ? this.keep(stale) : this.map;
    try {
      const response = await (this.options.fetch ?? fetch)(
        this.options.animeListUrl ?? ANIME_LIST_URL,
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const entries = JSON.parse(text) as ListEntry[];
      if (!Array.isArray(entries)) throw new Error('not a list');
      if (file) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, text);
        await rename(`${file}.tmp`, file);
      }
      return this.keep(entries);
    } catch (error) {
      this.failedAt = this.now();
      this.options.log?.warn({ err: error }, 'aniskip: anime-lists not available');
      return stale ? this.keep(stale) : this.map;
    }
  }

  private keep(entries: ListEntry[]): AnimeMap {
    this.map = new AnimeMap(entries);
    this.loadedAt = this.now();
    return this.map;
  }

  /**
   * The opening and ending of one episode, for a file of `lengthSeconds`;
   * nothing when AniSkip doesn't have it (404). Throws when AniSkip can't be
   * reached, so that it is asked again later.
   */
  async skipTimes(malId: number, episode: number, lengthSeconds: number): Promise<SkipTimes> {
    const base = (this.options.aniskipUrl ?? ANISKIP_URL).replace(/\/+$/, '');
    const types = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'].map((t) => `types=${t}`).join('&');
    const data = await this.json<AniSkipResponse>(
      `${base}/v2/skip-times/${malId}/${episode}?${types}&episodeLength=${Math.round(lengthSeconds)}`,
    );
    return pickSkipTimes(data, lengthSeconds);
  }
}

/** The opening (else a mixed one), the ending and the recap, when they fit in the file. */
export function pickSkipTimes(data: AniSkipResponse | undefined, lengthSeconds: number): SkipTimes {
  if (!data?.found || !Array.isArray(data.results)) return {};
  const range = (types: string[]): Range | undefined => {
    for (const type of types) {
      const result = data.results?.find((r) => r.skipType === type);
      const start = result?.interval?.startTime;
      const end = result?.interval?.endTime;
      if (typeof start !== 'number' || typeof end !== 'number') continue;
      if (start < 0 || end <= start + 5 || end > lengthSeconds + 2) continue;
      return { start, end: Math.min(end, lengthSeconds) };
    }
    return undefined;
  };
  const intro = range(['op', 'mixed-op']);
  const credits = range(['ed', 'mixed-ed']);
  const recap = range(['recap']);
  return { ...(intro && { intro }), ...(credits && { credits }), ...(recap && { recap }) };
}
