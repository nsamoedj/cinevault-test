// AniList (graphql.anilist.co): a second source for "Ontdekken", for anime.
// TMDB has most anime, but its lists miss much of a season, and its search
// knows the English title only: "Kimetsu no Yaiba" or "Shingeki no Kyojin"
// found nothing. AniList has every season, and searches romaji, English,
// Japanese and synonyms.
//
// A request still goes to Sonarr or Radarr by TMDB id (and Sonarr by the TVDB
// id TMDB gives). So each AniList title becomes its TMDB title: through the
// Fribb anime-lists (also used by AniSkip), else a TMDB search on its title
// and year. A later season ("… Season 2") becomes its show. A title TMDB
// doesn't know (yet) is left out: it could not be asked for.

import type { AnimeMap } from '../intro/aniskip.js';
import { anilistImageRef } from '../images.js';
import type { RequestCandidate } from '../metadata/tmdb.js';

const ANILIST_URL = 'https://graphql.anilist.co';
/** AniList allows 90 requests a minute (30 when busy). */
const MIN_INTERVAL_MS = 700;
/** A title found on TMDB stays found; one that wasn't is tried again after a day. */
const NOT_FOUND_MS = 24 * 3600_000;
/**
 * TMDB searches for titles the anime-lists don't have (yet), per list: about a
 * third of AniList's titles is in them (2026-11), the well-known ones more.
 * They run side by side (TMDB's limiter spaces them), and what is found stays known.
 */
const MAX_SEARCHES = 40;

export type AniListSort = 'TRENDING_DESC' | 'POPULARITY_DESC' | 'SEARCH_MATCH' | 'SCORE_DESC';
export type AniListFormat = 'TV' | 'TV_SHORT' | 'ONA' | 'OVA' | 'MOVIE' | 'SPECIAL';
export type AniListSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

export interface AniListQuery {
  sort: AniListSort[];
  season?: AniListSeason;
  seasonYear?: number;
  status?: 'RELEASING' | 'NOT_YET_RELEASED' | 'FINISHED';
  format_in?: AniListFormat[];
  search?: string;
}

export interface AniListMedia {
  id: number;
  idMal?: number | null;
  format?: string | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null };
  synonyms?: string[] | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null };
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null };
  bannerImage?: string | null;
  averageScore?: number | null;
}

interface PageResponse {
  data?: {
    Page?: { pageInfo?: { hasNextPage?: boolean | null }; media?: AniListMedia[] | null };
  };
  errors?: { message?: string; status?: number }[];
}

const QUERY = `query ($page: Int, $perPage: Int, $sort: [MediaSort], $season: MediaSeason,
  $seasonYear: Int, $status: MediaStatus, $format_in: [MediaFormat], $search: String) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, isAdult: false, sort: $sort, season: $season, seasonYear: $seasonYear,
      status: $status, format_in: $format_in, search: $search) {
      id idMal format synonyms averageScore bannerImage
      title { romaji english native }
      startDate { year month day }
      description(asHtml: false)
      coverImage { extraLarge large }
    }
  }
}`;

export class AniListError extends Error {}

export interface AniListClientOptions {
  url?: string;
  fetch?: typeof fetch;
}

export class AniListClient {
  private readonly fetchFn: typeof fetch;
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private readonly options: AniListClientOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
  }

  /** One page of anime; one request at a time, spaced for AniList's limit. */
  page(
    query: AniListQuery,
    page: number,
    perPage: number,
  ): Promise<{ media: AniListMedia[]; hasNextPage: boolean }> {
    const run = this.queue.then(async () => {
      const wait = this.last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.last = Date.now();
      return this.request(query, page, perPage);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(query: AniListQuery, page: number, perPage: number) {
    const variables: Record<string, unknown> = { page, perPage };
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) variables[key] = value;
    let response: Response;
    try {
      response = await this.fetchFn(this.options.url ?? ANILIST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AniListError(`AniList not reachable: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => undefined)) as PageResponse | undefined;
    if (!response.ok || !body?.data?.Page) {
      const message = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new AniListError(`AniList: ${message}`);
    }
    return {
      media: body.data.Page.media ?? [],
      hasNextPage: Boolean(body.data.Page.pageInfo?.hasNextPage),
    };
  }
}

/** A card from AniList: a TMDB title, plus AniList's names for it (for ranking a search). */
export interface AnimeCandidate extends RequestCandidate {
  names: string[];
}

/** "Season 2", "2nd Season", "Part 2", "The Final Season" at the end of a title. */
const SEQUEL =
  /[\s:–-]*(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season|(?:the\s+)?final\s+season|part\s*\d+|cour\s*\d+)\s*$/i;

export function withoutSeason(title: string): { title: string; sequel: boolean } {
  let rest = title.trim();
  let sequel = false;
  for (let i = 0; i < 2 && SEQUEL.test(rest); i++) {
    rest = rest.replace(SEQUEL, '').trim();
    sequel = true;
  }
  return { title: rest || title.trim(), sequel };
}

/** AniList's description without its markup and "(Source: …)" notes. */
export function plainDescription(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\(Source:[^)]*\)/gi, '')
    .replace(/\[Written by[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain || undefined;
}

interface TmdbSearch {
  searchAll(query: string, page?: number): Promise<{ results: RequestCandidate[] }>;
}

export interface AnimeDiscoveryOptions {
  client: AniListClient;
  /** The Fribb anime-lists (AniSkip keeps them in CACHE_DIR). */
  animeMap: () => Promise<AnimeMap | undefined>;
  tmdb: () => TmdbSearch | undefined;
  now?: () => number;
  log?: { warn(obj: object, msg?: string): void };
}

export class AnimeDiscovery {
  /** AniList id → TMDB title (or none, with when that was decided). */
  private readonly found = new Map<
    number,
    { kind: 'movie' | 'tv'; id: number } | { none: number }
  >();

  constructor(private readonly options: AnimeDiscoveryOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A list of AniList as TMDB cards (those TMDB knows), with whether there is a next page. */
  async list(
    query: AniListQuery,
    page: number,
    perPage = 40,
  ): Promise<{ results: AnimeCandidate[]; hasNextPage: boolean }> {
    const { media, hasNextPage } = await this.options.client.page(query, page, perPage);
    return { results: await this.toCandidates(media), hasNextPage };
  }

  async search(q: string): Promise<AnimeCandidate[]> {
    return (await this.list({ sort: ['SEARCH_MATCH'], search: q }, 1, 15)).results;
  }

  private async toCandidates(media: AniListMedia[]): Promise<AnimeCandidate[]> {
    const map = await this.options.animeMap().catch(() => undefined);
    const targets = media.map((m) => this.known(m, map));
    let searches = 0;
    await Promise.all(
      targets.map(async (target, i) => {
        const m = media[i];
        if (target !== undefined || !m || searches >= MAX_SEARCHES) return;
        searches++;
        targets[i] = await this.searchTmdb(m);
      }),
    );
    const seen = new Set<string>();
    const cards: AnimeCandidate[] = [];
    for (const [i, m] of media.entries()) {
      const target = targets[i];
      if (!target) continue;
      // A later season is its show: one card per show.
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(this.card(m, target));
    }
    return cards;
  }

  /** From the anime-lists or an earlier search; null: not on TMDB; undefined: not known yet. */
  private known(
    m: AniListMedia,
    map: AnimeMap | undefined,
  ): { kind: 'movie' | 'tv'; id: number } | null | undefined {
    const listed = map?.ids(m.id, m.idMal)?.tmdb;
    if (listed) return listed;
    const earlier = this.found.get(m.id);
    if (!earlier) return undefined;
    if ('none' in earlier) return this.now() - earlier.none < NOT_FOUND_MS ? null : undefined;
    return earlier;
  }

  /** The TMDB title for an AniList title the anime-lists don't have: Japanese animation, of its year. */
  private async searchTmdb(m: AniListMedia): Promise<{ kind: 'movie' | 'tv'; id: number } | null> {
    const tmdb = this.options.tmdb();
    if (!tmdb) return null;
    const kind = m.format === 'MOVIE' ? 'movie' : 'tv';
    const year = m.startDate?.year ?? undefined;
    const names = [m.title?.english, m.title?.romaji].filter((t): t is string => Boolean(t));
    try {
      for (const name of [...new Set(names)]) {
        const { title, sequel } = withoutSeason(name);
        const { results } = await tmdb.searchAll(title);
        const hit = results.find((r) => {
          if (r.kind !== kind || !r.anime) return false;
          if (!year || !r.year) return true;
          // A later season's show started earlier.
          return sequel || kind === 'tv'
            ? r.year <= year + 1 && (sequel || r.year >= year - 1)
            : Math.abs(r.year - year) <= 1;
        });
        if (hit) {
          const target = { kind, id: hit.tmdbId } as const;
          this.found.set(m.id, target);
          return target;
        }
      }
    } catch (error) {
      // TMDB busy or away: try again next time, without remembering "none".
      this.options.log?.warn({ err: error, anilistId: m.id }, 'anilist: TMDB search failed');
      return null;
    }
    this.found.set(m.id, { none: this.now() });
    if (this.found.size > 5000) this.found.clear();
    return null;
  }

  private card(m: AniListMedia, target: { kind: 'movie' | 'tv'; id: number }): AnimeCandidate {
    const title = m.title?.english || m.title?.romaji || m.title?.native || `AniList ${m.id}`;
    const start = m.startDate;
    const releaseDate =
      start?.year && start.month && start.day
        ? `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`
        : undefined;
    const overview = plainDescription(m.description);
    const posterRef = anilistImageRef(m.coverImage?.extraLarge ?? m.coverImage?.large);
    const backdropRef = anilistImageRef(m.bannerImage);
    const names = [m.title?.english, m.title?.romaji, m.title?.native, ...(m.synonyms ?? [])];
    return {
      kind: target.kind,
      tmdbId: target.id,
      title,
      ...(start?.year && { year: start.year }),
      ...(releaseDate && { releaseDate }),
      ...(overview && { overview }),
      ...(posterRef && { posterRef }),
      ...(backdropRef && { backdropRef }),
      ...(m.averageScore && { rating: Math.round(m.averageScore) / 10 }),
      anime: true,
      names: names.filter((n): n is string => Boolean(n)),
    };
  }
}

/** The anime season a date falls in (AniList's seasons: winter is January to March). */
export function animeSeason(at: number): { season: AniListSeason; seasonYear: number } {
  const date = new Date(at);
  const seasons: AniListSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  return {
    season: seasons[Math.floor(date.getUTCMonth() / 3)] ?? 'WINTER',
    seasonYear: date.getUTCFullYear(),
  };
}

/** Lower case, letters and digits only (any script), single spaces. */
function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** How well a title answers a search: 3 the same, 2 begins with it, 1 has its words, else 0. */
export function matchScore(query: string, names: string[]): number {
  const q = normalize(query);
  if (!q) return 0;
  const words = q.split(' ');
  let best = 0;
  for (const name of names) {
    const n = normalize(name);
    if (!n) continue;
    if (n === q) return 3;
    if (n.startsWith(q)) best = Math.max(best, 2);
    else if (words.every((w) => n.split(' ').includes(w))) best = Math.max(best, 1);
  }
  return best;
}

/**
 * TMDB's results and AniList's together: the best match with the search
 * first, TMDB's before AniList's when equally good, each title once (with
 * TMDB's card, its poster and Dutch description).
 */
export function mergeSearch(
  q: string,
  tmdb: RequestCandidate[],
  anime: AnimeCandidate[],
): RequestCandidate[] {
  const scored = new Map<string, { card: RequestCandidate; score: number; order: number }>();
  let order = 0;
  for (const card of tmdb) {
    const key = `${card.kind}:${card.tmdbId}`;
    if (!scored.has(key))
      scored.set(key, { card, score: matchScore(q, [card.title]), order: order++ });
  }
  for (const card of anime) {
    const key = `${card.kind}:${card.tmdbId}`;
    const score = matchScore(q, card.names);
    const existing = scored.get(key);
    if (existing) existing.score = Math.max(existing.score, score);
    else {
      const { names: _names, ...plain } = card;
      scored.set(key, { card: plain, score, order: order++ });
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((s) => s.card);
}
