// TVmaze API. Fallback for shows; no key needed.
// Limit: at least 20 calls per 10 seconds per IP. Data is CC BY-SA 4.0:
// the UI must credit TVmaze for items with metadataProvider "tvmaze".

import { createJsonClient, createLimiter, type FetchFn, type JsonClient } from './http.js';
import type {
  Candidate,
  CastMember,
  EpisodeMetadata,
  ExternalIds,
  SearchQuery,
  ScheduledEpisodeMetadata,
  SeasonMetadata,
  ShowMetadata,
  ShowProvider,
} from './types.js';

const API = 'https://api.tvmaze.com';
const IMAGE_HOST = 'https://static.tvmaze.com/';
const CAST_LIMIT = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

interface TvmazeImage {
  medium?: string;
  original?: string;
}

interface TvmazeShow {
  id: number;
  name: string;
  premiered?: string | null;
  summary?: string | null;
  genres?: string[];
  rating?: { average?: number | null };
  runtime?: number | null;
  averageRuntime?: number | null;
  status?: string;
  image?: TvmazeImage | null;
  externals?: { thetvdb?: number | null; imdb?: string | null };
  _embedded?: {
    episodes?: {
      season: number;
      number: number | null;
      name?: string;
      airdate?: string;
      runtime?: number | null;
      summary?: string | null;
      image?: TvmazeImage | null;
    }[];
    cast?: {
      person: { name: string; image?: TvmazeImage | null };
      character?: { name?: string };
    }[];
  };
}

/** Full TVmaze image URL → "tvmaze:uploads/…" (served by the image cache). */
export function tvmazeImage(image: TvmazeImage | null | undefined): string | undefined {
  const url = image?.original ?? image?.medium;
  return url?.startsWith(IMAGE_HOST) ? `tvmaze:${url.slice(IMAGE_HOST.length)}` : undefined;
}

/** TVmaze summaries are HTML. */
export function stripHtml(html: string | null | undefined): string | undefined {
  const plain = html
    ?.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
  return plain ? plain : undefined;
}

/** A full date, YYYY-MM-DD, or nothing. */
function dateOf(date: string | null | undefined): string | undefined {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) && yearOf(date) ? date : undefined;
}

function yearOf(date: string | null | undefined): number | undefined {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : undefined;
}

export interface TvmazeOptions {
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  /** For "the next episode that has not aired yet". */
  now?: () => number;
}

export class TvmazeProvider implements ShowProvider {
  readonly name = 'tvmaze' as const;
  private readonly get: JsonClient;
  private readonly now: () => number;

  constructor(options: TvmazeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.get = createJsonClient({
      // 20 calls per 10 s → one every 500 ms, with some margin.
      limiter: createLimiter({ minIntervalMs: 550, concurrency: 1 }),
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.sleep && { sleep: options.sleep }),
    });
  }

  async searchShows(query: SearchQuery): Promise<Candidate[]> {
    const results = await this.get<{ show: TvmazeShow }[]>(
      `${API}/search/shows?q=${encodeURIComponent(query.title)}`,
    );
    return (results ?? []).map(({ show }) => {
      const year = yearOf(show.premiered);
      const overview = stripHtml(show.summary);
      const posterRef = tvmazeImage(show.image);
      return {
        provider: 'tvmaze' as const,
        id: show.id,
        title: show.name,
        ...(year && { year }),
        ...(overview && { overview }),
        ...(posterRef && { posterRef }),
      };
    });
  }

  async findShow(ids: ExternalIds): Promise<number | undefined> {
    if (ids.tvmaze) return ids.tvmaze;
    const lookups: string[] = [];
    if (ids.tvdb) lookups.push(`thetvdb=${ids.tvdb}`);
    if (ids.imdb) lookups.push(`imdb=${encodeURIComponent(ids.imdb)}`);
    for (const lookup of lookups) {
      // Redirects to the show; fetch follows it.
      const show = await this.get<TvmazeShow>(`${API}/lookup/shows?${lookup}`);
      if (show?.id) return show.id;
    }
    return undefined;
  }

  async getShow(id: number, seasons?: number[]): Promise<ShowMetadata | undefined> {
    const show = await this.get<TvmazeShow>(`${API}/shows/${id}?embed[]=episodes&embed[]=cast`);
    if (!show) return undefined;

    const bySeason = new Map<number, EpisodeMetadata[]>();
    for (const e of show._embedded?.episodes ?? []) {
      // Specials without a number can't be matched to files.
      if (e.number === null || e.number === undefined) continue;
      if (seasons && !seasons.includes(e.season)) continue;
      const title = e.name?.trim();
      const overview = stripHtml(e.summary);
      const stillRef = tvmazeImage(e.image);
      const list = bySeason.get(e.season) ?? [];
      list.push({
        season: e.season,
        episode: e.number,
        ...(title && { title }),
        ...(overview && { overview }),
        ...(e.airdate && { airDate: e.airdate }),
        ...(e.runtime && { runtimeMinutes: e.runtime }),
        ...(stillRef && { stillRef }),
      });
      bySeason.set(e.season, list);
    }
    const seasonList: SeasonMetadata[] = [...bySeason.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season, episodes]) => ({ season, episodeCount: episodes.length, episodes }));

    const cast: CastMember[] = (show._embedded?.cast ?? []).slice(0, CAST_LIMIT).map((c, order) => {
      const profileRef = tvmazeImage(c.person.image);
      return {
        name: c.person.name,
        ...(c.character?.name && { character: c.character.name }),
        ...(profileRef && { profileRef }),
        order,
      };
    });

    // The first numbered episode that has not aired yet (TVmaze lists them ahead).
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const upcoming = (show._embedded?.episodes ?? [])
      .filter((e) => e.number !== null && e.number !== undefined && e.season > 0)
      .filter((e) => dateOf(e.airdate) && (e.airdate ?? '') >= today)
      .sort((a, b) => (a.airdate ?? '').localeCompare(b.airdate ?? ''))[0];
    const nextTitle = upcoming?.name?.trim();

    // The calendar: numbered episodes that air within a year either way.
    const from = new Date(this.now() - 365 * DAY_MS).toISOString().slice(0, 10);
    const until = new Date(this.now() + 365 * DAY_MS).toISOString().slice(0, 10);
    const schedule: ScheduledEpisodeMetadata[] = (show._embedded?.episodes ?? []).flatMap((e) => {
      const airDate = dateOf(e.airdate);
      if (e.number === null || e.number === undefined || e.season <= 0) return [];
      if (!airDate || airDate < from || airDate > until) return [];
      const title = e.name?.trim();
      const overview = stripHtml(e.summary);
      return [
        {
          season: e.season,
          episode: e.number,
          ...(title && { title }),
          ...(overview && { overview }),
          airDate,
        },
      ];
    });

    const year = yearOf(show.premiered);
    const releaseDate = dateOf(show.premiered);
    const overview = stripHtml(show.summary);
    const runtime = show.runtime ?? show.averageRuntime;
    const posterRef = tvmazeImage(show.image);
    const tvdb = show.externals?.thetvdb;
    const imdb = show.externals?.imdb;
    return {
      provider: 'tvmaze',
      id: show.id,
      title: show.name,
      ...(year && { year }),
      ...(releaseDate && { releaseDate }),
      ...(overview && { overview }),
      genres: show.genres ?? [],
      ...(show.rating?.average && { rating: show.rating.average }),
      ...(runtime && { runtimeMinutes: runtime }),
      ...(show.status && { status: show.status }),
      ...(posterRef && { posterRef }),
      ...(upcoming?.airdate && {
        nextEpisode: {
          season: upcoming.season,
          episode: upcoming.number as number,
          ...(nextTitle && { title: nextTitle }),
          airDate: upcoming.airdate,
        },
      }),
      ...(schedule.length > 0 && { schedule }),
      cast,
      ids: { tvmaze: show.id, ...(tvdb && { tvdb }), ...(imdb && { imdb }) },
      seasons: seasonList,
    };
  }
}
