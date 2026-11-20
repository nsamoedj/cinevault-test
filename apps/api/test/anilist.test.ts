// "Ontdekken" with AniList: its lists and searches as TMDB titles (through the
// anime-lists, else a TMDB search), and a search merged with TMDB's. A fake
// AniList over fetch; AniList itself is blocked in the cloud sandbox.

import { describe, expect, it } from 'vitest';
import { AnimeMap } from '../src/intro/aniskip.js';
import { anilistImageRef, imageUrl } from '../src/images.js';
import type { RequestCandidate } from '../src/metadata/tmdb.js';
import {
  AniListClient,
  AnimeDiscovery,
  animeSeason,
  matchScore,
  mergeSearch,
  plainDescription,
  withoutSeason,
  type AniListMedia,
} from '../src/requests/anilist.js';

const COVER = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large';

function media(id: number, extra: Partial<AniListMedia> = {}): AniListMedia {
  return {
    id,
    format: 'TV',
    title: { romaji: `Romaji ${id}`, english: `English ${id}` },
    startDate: { year: 2024, month: 10, day: 4 },
    coverImage: { extraLarge: `${COVER}/bx${id}-abc.jpg` },
    averageScore: 87,
    ...extra,
  };
}

const LIST = [
  // Attack on Titan, and its second season (the same show on TMDB).
  { anilist_id: 16498, mal_id: 16498, tvdb_id: 267440, themoviedb_id: { tv: 1429 } },
  { anilist_id: 20958, mal_id: 25777, tvdb_id: 267440, themoviedb_id: { tv: 1429 } },
  // A film, and one known only by its MyAnimeList id.
  { anilist_id: 21519, mal_id: 32281, themoviedb_id: { movie: 372058 } },
  { mal_id: 38000, tvdb_id: 348545, themoviedb_id: { tv: 85937 } },
];

/** A fake AniList: answers each query with the next list, and records the variables. */
function fakeAniList(pages: AniListMedia[][], seen: Record<string, unknown>[] = []) {
  return new AniListClient({
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      seen.push(body.variables);
      const list = pages.shift();
      if (!list)
        return new Response(JSON.stringify({ errors: [{ message: 'Too Many Requests' }] }), {
          status: 429,
        });
      return new Response(
        JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: true }, media: list } } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
}

function fakeTmdb(results: RequestCandidate[], calls: string[] = []) {
  return {
    async searchAll(q: string) {
      calls.push(q);
      return { results };
    },
  };
}

describe('AniList titles', () => {
  it('knows a later season, and cleans up descriptions', () => {
    expect(withoutSeason('Attack on Titan Season 2')).toEqual({
      title: 'Attack on Titan',
      sequel: true,
    });
    expect(withoutSeason('Mushoku Tensei: Jobless Reincarnation Season 2 Part 2')).toEqual({
      title: 'Mushoku Tensei: Jobless Reincarnation',
      sequel: true,
    });
    expect(withoutSeason('Shingeki no Kyojin: The Final Season')).toEqual({
      title: 'Shingeki no Kyojin',
      sequel: true,
    });
    expect(withoutSeason('Frieren')).toEqual({ title: 'Frieren', sequel: false });
    expect(
      plainDescription(
        'Eren <i>Jaeger</i> swore<br><br>revenge &amp; more.\n(Source: Crunchyroll)',
      ),
    ).toBe('Eren Jaeger swore\n\nrevenge & more.');
    expect(plainDescription('')).toBeUndefined();
  });

  it('knows the season of a date', () => {
    expect(animeSeason(Date.parse('2026-11-05'))).toEqual({ season: 'FALL', seasonYear: 2026 });
    expect(animeSeason(Date.parse('2027-01-02'))).toEqual({ season: 'WINTER', seasonYear: 2027 });
    expect(animeSeason(Date.parse('2026-04-01'))).toEqual({ season: 'SPRING', seasonYear: 2026 });
  });

  it('keeps AniList pictures in the image cache, and nothing from elsewhere', () => {
    const ref = anilistImageRef(`${COVER}/bx16498-73IhOXpJZiMF.jpg`);
    expect(ref).toBe('anilist:media/anime/cover/large/bx16498-73IhOXpJZiMF.jpg');
    expect(imageUrl(ref)).toBe(
      '/api/images/anilist/media/anime/cover/large/bx16498-73IhOXpJZiMF.jpg',
    );
    expect(anilistImageRef('https://example.com/file/anilistcdn/x.jpg')).toBeUndefined();
    expect(anilistImageRef(`${COVER}/../../x.jpg`)).toBeUndefined();
    expect(anilistImageRef(null)).toBeUndefined();
  });

  it('finds the TMDB title of an AniList entry in the anime-lists', () => {
    const map = new AnimeMap(LIST);
    expect(map.ids(20958)).toEqual({ tmdb: { kind: 'tv', id: 1429 }, tvdbId: 267440 });
    expect(map.ids(21519)?.tmdb).toEqual({ kind: 'movie', id: 372058 });
    // No AniList id in the list: by its MyAnimeList id.
    expect(map.ids(101922, 38000)?.tmdb).toEqual({ kind: 'tv', id: 85937 });
    expect(map.ids(1)).toBeUndefined();
  });
});

describe('AnimeDiscovery', () => {
  it('turns an AniList list into TMDB cards, a later season into its show', async () => {
    const seen: Record<string, unknown>[] = [];
    const tmdbCalls: string[] = [];
    const discovery = new AnimeDiscovery({
      client: fakeAniList(
        [
          [
            media(16498, { title: { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin' } }),
            media(20958, { title: { english: 'Attack on Titan Season 2' } }),
            media(21519, { format: 'MOVIE', title: { romaji: 'Kimi no Na wa.' } }),
          ],
        ],
        seen,
      ),
      animeMap: async () => new AnimeMap(LIST),
      tmdb: () => fakeTmdb([], tmdbCalls),
    });
    const { results, hasNextPage } = await discovery.list(
      { sort: ['POPULARITY_DESC'], season: 'FALL', seasonYear: 2026 },
      2,
    );
    expect(seen[0]).toEqual({
      page: 2,
      perPage: 40,
      sort: ['POPULARITY_DESC'],
      season: 'FALL',
      seasonYear: 2026,
    });
    expect(hasNextPage).toBe(true);
    expect(results.map((r) => [r.kind, r.tmdbId, r.title])).toEqual([
      ['tv', 1429, 'Attack on Titan'],
      ['movie', 372058, 'Kimi no Na wa.'],
    ]);
    expect(results[0]).toMatchObject({
      year: 2024,
      releaseDate: '2024-10-04',
      rating: 8.7,
      anime: true,
      posterRef: 'anilist:media/anime/cover/large/bx16498-abc.jpg',
      names: ['Attack on Titan', 'Shingeki no Kyojin'],
    });
    // All in the anime-lists: no TMDB search.
    expect(tmdbCalls).toEqual([]);
  });

  it("searches TMDB for a title the anime-lists don't have yet, and remembers it", async () => {
    const tmdbCalls: string[] = [];
    let now = Date.parse('2026-11-05T12:00:00Z');
    const fresh = media(999001, {
      title: { english: 'Dan Da Dan Season 2', romaji: 'Dandadan 2nd Season' },
      startDate: { year: 2025 },
    });
    const unknown = media(999002, { title: { english: 'Nowhere' }, startDate: { year: 2026 } });
    const discovery = new AnimeDiscovery({
      client: fakeAniList([
        [fresh, unknown],
        [fresh, unknown],
        [fresh, unknown],
      ]),
      animeMap: async () => new AnimeMap(LIST),
      tmdb: () =>
        fakeTmdb(
          [
            // Not anime, and anime of the wrong year: skipped.
            { kind: 'tv', tmdbId: 1, title: 'Dan Da Dan', year: 2024, anime: false },
            { kind: 'movie', tmdbId: 2, title: 'Dan Da Dan', year: 2024, anime: true },
            { kind: 'tv', tmdbId: 240411, title: 'DAN DA DAN', year: 2024, anime: true },
          ],
          tmdbCalls,
        ),
      now: () => now,
    });
    const first = await discovery.list({ sort: ['TRENDING_DESC'] }, 1);
    // The season's show (2024, before the season of 2025).
    expect(first.results.map((r) => [r.tmdbId, r.title])).toEqual([
      [240411, 'Dan Da Dan Season 2'],
    ]);
    // Found by its English name (the romaji one isn't needed). "Nowhere" found
    // nothing: tried once, then not again for a day; Dan Da Dan is remembered.
    expect(tmdbCalls).toEqual(['Dan Da Dan', 'Nowhere']);
    await discovery.list({ sort: ['TRENDING_DESC'] }, 1);
    expect(tmdbCalls).toHaveLength(2);
    now += 25 * 3600_000;
    await discovery.list({ sort: ['TRENDING_DESC'] }, 1);
    expect(tmdbCalls).toEqual(['Dan Da Dan', 'Nowhere', 'Nowhere']);
  });

  it('fails when AniList does, so the row can fall back on TMDB', async () => {
    const discovery = new AnimeDiscovery({
      client: fakeAniList([]),
      animeMap: async () => undefined,
      tmdb: () => undefined,
    });
    await expect(discovery.list({ sort: ['TRENDING_DESC'] }, 1)).rejects.toThrow(
      'AniList: Too Many Requests',
    );
  });
});

describe('a search over TMDB and AniList', () => {
  const tmdb = (tmdbId: number, title: string, kind: 'movie' | 'tv' = 'tv') =>
    ({ kind, tmdbId, title, anime: false }) as RequestCandidate;
  const anime = (tmdbId: number, title: string, names: string[]) => ({
    kind: 'tv' as const,
    tmdbId,
    title,
    anime: true,
    names,
  });

  it('ranks how well a title answers the search', () => {
    expect(matchScore('shingeki no kyojin', ['Attack on Titan', 'Shingeki no Kyojin'])).toBe(3);
    expect(matchScore('kimetsu', ['Kimetsu no Yaiba'])).toBe(2);
    expect(matchScore('titan attack', ['Attack on Titan'])).toBe(1);
    expect(matchScore('Frieren', ['Sousou no Frieren'])).toBe(1);
    expect(matchScore('dune', ['Batman'])).toBe(0);
    expect(matchScore('Pokémon', ['Pokemon Horizons'])).toBe(2);
  });

  it('puts the anime a romaji search means first, and each title once', () => {
    // TMDB knows the English title only: its results don't match "kimetsu".
    const merged = mergeSearch(
      'kimetsu',
      [tmdb(10, 'Kim Possible'), tmdb(85937, 'Demon Slayer: Kimetsu no Yaiba')],
      [
        anime(85937, 'Demon Slayer', ['Demon Slayer', 'Kimetsu no Yaiba']),
        anime(500, 'Kimetsu Gakuen', ['Kimetsu Gakuen']),
      ],
    );
    expect(merged.map((c) => c.title)).toEqual([
      // TMDB's card for the same title, before AniList's equally good one.
      'Demon Slayer: Kimetsu no Yaiba',
      'Kimetsu Gakuen',
      'Kim Possible',
    ]);
    expect(merged[1]).not.toHaveProperty('names');
  });

  it("keeps TMDB's order for a search that isn't about anime", () => {
    const merged = mergeSearch(
      'batman',
      [
        tmdb(1, 'Batman', 'movie'),
        tmdb(2, 'The Batman', 'movie'),
        tmdb(3, 'Batman Begins', 'movie'),
      ],
      [anime(4, 'Batman Ninja', ['Batman Ninja'])],
    );
    expect(merged.map((c) => c.title)).toEqual([
      'Batman',
      'Batman Begins',
      'Batman Ninja',
      'The Batman',
    ]);
  });
});
