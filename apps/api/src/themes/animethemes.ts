// AnimeThemes (animethemes.moe): the openings and endings of anime, as audio
// files, per MyAnimeList entry. The second source of theme music (verzoek
// eigenaar, 2026-10-22), after Plex, which has few anime: a show that Plex has
// nothing for gets its first opening from here.
//
// The show's TVDB (or TMDB) id becomes a MyAnimeList id with the Fribb
// anime-lists of AniSkip (the first cour of its first season). AnimeThemes
// serves Ogg audio; FFmpeg makes an MP3 of it, like the themes of Plex, so
// every player (Safari too) can play it.

import type { PrismaClient } from '../generated/prisma/client.js';
import type { AnimeMap } from '../intro/aniskip.js';
import { toMp3 } from './audio.js';
import {
  isMp3,
  NoThemeError,
  type ThemeProvider,
  type ThemeSource,
  ThemeUnavailableError,
} from './service.js';

export const ANIMETHEMES_URL = 'https://api.animethemes.moe';
/** Nothing there: asked again after a week (new seasons get their openings later). */
const MISSING_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const MIN_BYTES = 10_000;
const MAX_BYTES = 25_000_000;

interface AnimeThemesSource extends ThemeSource {
  malId: number;
}

/** As far as CineVault reads it: GET /anime with the themes, entries, videos and audio. */
interface AnimeResponse {
  anime?: {
    name?: string;
    animethemes?: {
      type?: string;
      sequence?: number | null;
      animethemeentries?: {
        version?: number | null;
        nsfw?: boolean;
        spoiler?: boolean;
        videos?: { audio?: { link?: string; size?: number } | null }[];
      }[];
    }[];
  }[];
}

export interface AnimeThemesOptions {
  /** The Fribb anime-lists (AniSkip's): undefined while they can't be fetched. */
  animeMap: () => Promise<AnimeMap | undefined>;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Ogg to MP3; FFmpeg by default (FFMPEG_PATH). */
  toMp3?: (audio: Buffer) => Promise<Buffer>;
  ffmpeg?: string;
}

export class AnimeThemesProvider implements ThemeProvider<AnimeThemesSource> {
  readonly name = 'animethemes' as const;
  private readonly prisma: PrismaClient;
  private readonly options: AnimeThemesOptions;

  constructor(prisma: PrismaClient, options: AnimeThemesOptions) {
    this.prisma = prisma;
    this.options = options;
  }

  async sources(itemId: string): Promise<AnimeThemesSource[]> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: { type: true, tvdbId: true, tmdbId: true },
    });
    if (item?.type !== 'SHOW' || (!item.tvdbId && !item.tmdbId)) return [];
    const map = await this.options.animeMap().catch(() => undefined);
    // Not an anime (or the lists aren't there yet): nothing to ask.
    const malId = map?.first({ tvdbId: item.tvdbId, tmdbId: item.tmdbId });
    return malId ? [{ provider: this.name, version: `mal-${malId}`, malId }] : [];
  }

  async audio(source: AnimeThemesSource): Promise<Buffer> {
    const base = (this.options.baseUrl ?? ANIMETHEMES_URL).replace(/\/+$/, '');
    const query = [
      'filter[has]=resources',
      'filter[site]=MyAnimeList',
      `filter[external_id]=${source.malId}`,
      'include=animethemes.animethemeentries.videos.audio',
    ].join('&');
    const response = await this.get(`${base}/anime?${query}`, `list, MAL ${source.malId}`);
    const data = (await response.json().catch(() => undefined)) as AnimeResponse | undefined;
    const anime = data?.anime?.[0];
    if (!anime) {
      throw new NoThemeError(
        `AnimeThemes has no anime for MAL ${source.malId}`,
        MISSING_MS,
        'niet bij AnimeThemes',
      );
    }
    const link = pickOpening(anime);
    if (!link) {
      throw new NoThemeError(
        `AnimeThemes has no opening for MAL ${source.malId}`,
        MISSING_MS,
        'geen opening',
      );
    }
    const file = await this.get(link, `audio file, MAL ${source.malId}`);
    const audio = Buffer.from(await file.arrayBuffer());
    if (audio.length < MIN_BYTES || audio.length > MAX_BYTES) {
      throw new Error(`AnimeThemes audio of ${audio.length} bytes`);
    }
    const mp3 = await (this.options.toMp3 ?? ((a) => toMp3(a, { ffmpeg: this.options.ffmpeg })))(
      audio,
    );
    if (!isMp3(mp3)) throw new Error('FFmpeg made no MP3 of the AnimeThemes audio');
    return mp3;
  }

  /** `what`: which request, in the errors Beheer shows (the list or the audio file). */
  private async get(url: string, what: string): Promise<Response> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        headers: { 'user-agent': 'CineVault (theme music)', accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ThemeUnavailableError(`AnimeThemes not reachable (${what}): ${String(error)}`);
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ThemeUnavailableError(`AnimeThemes answered ${response.status} (${what})`);
    }
    if (response.status === 404) {
      throw new NoThemeError(`AnimeThemes: 404 for ${url}`, MISSING_MS, '404');
    }
    if (!response.ok) throw new Error(`AnimeThemes answered ${response.status} (${what})`);
    return response;
  }
}

/**
 * The first opening (OP1, else the lowest), its first version without spoilers
 * or nsfw (else any), and the first video of it with audio.
 */
export function pickOpening(
  anime: NonNullable<AnimeResponse['anime']>[number],
): string | undefined {
  const openings = (anime.animethemes ?? [])
    .filter((t) => t.type === 'OP')
    .sort((a, b) => (a.sequence ?? 1) - (b.sequence ?? 1));
  for (const theme of openings) {
    const entries = [...(theme.animethemeentries ?? [])].sort(
      (a, b) =>
        Number(Boolean(a.spoiler || a.nsfw)) - Number(Boolean(b.spoiler || b.nsfw)) ||
        (a.version ?? 1) - (b.version ?? 1),
    );
    for (const entry of entries) {
      const link = entry.videos?.find((v) => v.audio?.link)?.audio?.link;
      if (link) return link;
    }
  }
  return undefined;
}
