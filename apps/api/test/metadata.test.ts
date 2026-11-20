import { describe, expect, it } from 'vitest';
import { createJsonClient, createLimiter, HttpError } from '../src/metadata/http.js';
import {
  alternativeTitles,
  normalizeTitle,
  pickBest,
  titleSimilarity,
} from '../src/metadata/match.js';
import { assignAbsoluteNumbers, MetadataService } from '../src/metadata/service.js';
import { TmdbProvider } from '../src/metadata/tmdb.js';
import { stripHtml, TvmazeProvider } from '../src/metadata/tvmaze.js';
import type { Candidate, ShowMetadata } from '../src/metadata/types.js';
import { fakeFetch, noSleep, path } from './metadata-helpers.js';

const fastLimiter = createLimiter({ minIntervalMs: 0, concurrency: 8 });

describe('http client', () => {
  it('retries 429 using Retry-After, returns undefined on 404, throws on 401', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/busy')) {
        attempts++;
        return attempts < 3
          ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
          : new Response('{"ok":true}', { status: 200 });
      }
      if (url.endsWith('/missing')) return new Response('', { status: 404 });
      return new Response('', { status: 401 });
    }) as typeof fetch;
    const get = createJsonClient({
      limiter: fastLimiter,
      fetch: fetchFn,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(get('https://x/busy')).resolves.toEqual({ ok: true });
    expect(waits).toEqual([2000, 2000]);
    await expect(get('https://x/missing')).resolves.toBeUndefined();
    await expect(get('https://x/denied')).rejects.toBeInstanceOf(HttpError);
  });

  it('never puts an API key in error messages', async () => {
    const { fetch } = fakeFetch([{ match: () => true, status: 401 }]);
    const tmdb = new TmdbProvider({ apiKey: 'secret-key-123', fetch, sleep: noSleep });
    const error = await tmdb.searchMovies({ title: 'Alpha' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(String((error as Error).message)).toContain('HTTP 401');
    expect(String((error as Error).message)).not.toContain('secret-key-123');
    expect((error as HttpError).url).toContain('api_key=***');
  });

  it('limits concurrency and spaces out requests', async () => {
    const limiter = createLimiter({ minIntervalMs: 20, concurrency: 1 });
    const starts: number[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      starts.push(Date.now());
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };

    const first = limiter.schedule(task);
    // Block the event loop so the first timer fires late; the gap must still hold.
    const until = Date.now() + 15;
    while (Date.now() < until) {
      /* busy wait */
    }
    await Promise.all([first, limiter.schedule(task), limiter.schedule(task)]);

    expect(maxRunning).toBe(1);
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] ?? 0));
    // Date.now() has 1 ms resolution; the limiter reads it just before the task does.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(19);
  });
});

describe('matching', () => {
  it('normalizes case, punctuation and articles', () => {
    expect(normalizeTitle('BLUE LOCK')).toBe(normalizeTitle('Blue Lock'));
    expect(normalizeTitle('Code-Breaker')).toBe(normalizeTitle('Code:Breaker'));
    expect(normalizeTitle('The Punisher: One Last Kill')).toBe('punisheronelastkill');
    expect(normalizeTitle('Amélie')).toBe('amelie');
    expect(titleSimilarity('Alice in Borderland', 'Alice in Borderland')).toBe(1);
  });

  const legend: Candidate = { provider: 'tmdb', id: 1, title: 'A Legend', year: 2024 };
  const otherLegend: Candidate = { provider: 'tmdb', id: 2, title: 'Legend', year: 2015 };

  it('prefers the candidate whose year matches', () => {
    expect(pickBest({ title: 'A Legend', year: 2024 }, [otherLegend, legend])?.candidate.id).toBe(
      1,
    );
  });

  it('rejects a good title with the wrong year', () => {
    expect(pickBest({ title: 'Legend', year: 2024 }, [otherLegend])).toBeUndefined();
  });

  it('rejects loose title matches', () => {
    expect(
      pickBest({ title: 'Alpha', year: 2026 }, [
        { provider: 'tmdb', id: 3, title: 'Alphaville', year: 2026 },
      ]),
    ).toBeUndefined();
  });

  it('builds alternative titles for " - " separated names', () => {
    expect(
      alternativeTitles('A Marvel Television Special Presentation - The Punisher - One Last Kill'),
    ).toEqual([
      'A Marvel Television Special Presentation: The Punisher: One Last Kill',
      'The Punisher: One Last Kill',
    ]);
    expect(alternativeTitles('Alpha')).toEqual([]);
  });
});

const tmdbMovie = {
  id: 27205,
  title: 'Inception',
  original_title: 'Inception',
  release_date: '2010-07-15',
  overview: 'A thief who steals corporate secrets…',
  tagline: 'Your mind is the scene of the crime.',
  genres: [{ name: 'Action' }, { name: 'Science Fiction' }],
  vote_average: 8.4,
  runtime: 148,
  status: 'Released',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  imdb_id: 'tt1375666',
  credits: {
    cast: [{ name: 'Leonardo DiCaprio', character: 'Cobb', profile_path: '/leo.jpg', order: 0 }],
  },
};

describe('TmdbProvider', () => {
  it('searches, maps details and authenticates with a v3 key', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: path('/3/search/movie'),
        body: {
          results: [
            { id: 27205, title: 'Inception', release_date: '2010-07-15', poster_path: '/p.jpg' },
          ],
        },
      },
      { match: path('/3/movie/27205'), body: tmdbMovie },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'v3key', fetch, sleep: noSleep });

    expect(await tmdb.searchMovies({ title: 'Inception', year: 2010 })).toEqual([
      { provider: 'tmdb', id: 27205, title: 'Inception', year: 2010, posterRef: 'tmdb:w342/p.jpg' },
    ]);
    expect(calls[0]?.url.searchParams.get('api_key')).toBe('v3key');
    expect(calls[0]?.url.searchParams.get('primary_release_year')).toBe('2010');

    expect(await tmdb.getMovie(27205)).toEqual({
      provider: 'tmdb',
      id: 27205,
      title: 'Inception',
      year: 2010,
      releaseDate: '2010-07-15',
      overview: 'A thief who steals corporate secrets…',
      tagline: 'Your mind is the scene of the crime.',
      genres: ['Action', 'Science Fiction'],
      rating: 8.4,
      runtimeMinutes: 148,
      status: 'Released',
      posterRef: 'tmdb:w500/poster.jpg',
      backdropRef: 'tmdb:w1280/backdrop.jpg',
      cast: [
        { name: 'Leonardo DiCaprio', character: 'Cobb', profileRef: 'tmdb:w185/leo.jpg', order: 0 },
      ],
      ids: { tmdb: 27205, imdb: 'tt1375666' },
    });
  });

  it('uses a v4 token as bearer header', async () => {
    const { fetch, calls } = fakeFetch([{ match: path('/3/search/tv'), body: { results: [] } }]);
    const tmdb = new TmdbProvider({ apiKey: 'eyJhbGciOi.token', fetch, sleep: noSleep });
    await tmdb.searchShows({ title: 'Bleach' });
    expect(calls[0]?.url.searchParams.has('api_key')).toBe(false);
    expect(calls[0]?.headers.Authorization).toBe('Bearer eyJhbGciOi.token');
  });

  it('searches in English, describes in the configured language, titles in English', async () => {
    const lang = (pathname: string, language: string) => (u: URL) =>
      u.pathname === pathname && u.searchParams.get('language') === language;
    const { fetch, calls } = fakeFetch([
      {
        match: path('/3/search/movie'),
        body: { results: [{ id: 150540, title: 'Inside Out', release_date: '2015-06-09' }] },
      },
      {
        match: lang('/3/movie/150540', 'nl-NL'),
        body: {
          ...tmdbMovie,
          id: 150540,
          title: 'Binnenstebuiten',
          original_title: 'Inside Out',
          overview: 'Nederlandse beschrijving.',
          poster_path: '/nl.jpg',
        },
      },
      {
        match: lang('/3/movie/150540', 'en-US'),
        body: {
          ...tmdbMovie,
          id: 150540,
          title: 'Inside Out',
          original_title: 'Inside Out',
          poster_path: '/default.jpg',
          images: {
            posters: [
              { file_path: '/textless.jpg', iso_639_1: null },
              { file_path: '/en.jpg', iso_639_1: 'en' },
            ],
          },
        },
      },
    ]);
    const service = new MetadataService({
      tmdb: new TmdbProvider({ apiKey: 'k', language: 'nl-NL', fetch, sleep: noSleep }),
    });
    const result = await service.matchMovie({ title: 'Inside Out', year: 2015, ids: {} });

    expect(result).toMatchObject({
      status: 'matched',
      metadata: {
        title: 'Inside Out',
        overview: 'Nederlandse beschrijving.',
        posterRef: 'tmdb:w500/en.jpg',
      },
    });
    expect(result.status === 'matched' && result.metadata.originalTitle).toBe(undefined);
    expect(calls.map((c) => [c.url.pathname, c.url.searchParams.get('language')]).sort()).toEqual([
      ['/3/movie/150540', 'en-US'],
      ['/3/movie/150540', 'nl-NL'],
      ['/3/search/movie', 'en-US'],
    ]);
    const english = calls.find(
      (c) =>
        c.url.searchParams.get('language') === 'en-US' && c.url.pathname.startsWith('/3/movie'),
    );
    expect(english?.url.searchParams.get('include_image_language')).toBe('en,null');
  });

  it('takes the logo, the trailer and the recommendations', async () => {
    const { fetch } = fakeFetch([
      {
        match: path('/3/movie/8'),
        body: {
          ...tmdbMovie,
          id: 8,
          images: {
            logos: [
              { file_path: '/ja.png', iso_639_1: 'ja' },
              { file_path: '/en.svg', iso_639_1: 'en' },
              { file_path: '/en.png', iso_639_1: 'en' },
            ],
          },
          videos: {
            results: [
              { key: 'clip', site: 'YouTube', type: 'Clip' },
              { key: 'teaser', site: 'YouTube', type: 'Teaser' },
              { key: 'fan', site: 'YouTube', type: 'Trailer', official: false },
              { key: 'vimeo', site: 'Vimeo', type: 'Trailer', official: true },
              { key: 'real', site: 'YouTube', type: 'Trailer', official: true },
            ],
          },
          recommendations: { results: [{ id: 11 }, { id: 12 }] },
        },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'k', fetch, sleep: noSleep });
    expect(await tmdb.getMovie(8)).toMatchObject({
      logoRef: 'tmdb:w500/en.png',
      trailerKey: 'real',
      recommended: [11, 12],
    });
  });

  it('knows the next episode of a show', async () => {
    const { fetch } = fakeFetch([
      {
        match: path('/3/tv/9'),
        body: {
          id: 9,
          name: 'Bluey',
          seasons: [],
          next_episode_to_air: {
            air_date: '2026-11-02',
            season_number: 4,
            episode_number: 3,
            name: 'Episode 3',
          },
        },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'k', fetch, sleep: noSleep });
    // A placeholder name is no title.
    expect((await tmdb.getShow(9))?.nextEpisode).toEqual({
      season: 4,
      episode: 3,
      airDate: '2026-11-02',
    });
  });

  it('gives the air dates of the season on air and the next one, for the calendar', async () => {
    const season = (n: number, episodes: { episode_number: number; air_date?: string }[]) => ({
      season_number: n,
      episodes: episodes.map((e) => ({ season_number: n, name: `Real ${e.episode_number}`, ...e })),
    });
    const { fetch, calls } = fakeFetch([
      {
        match: path('/3/tv/9/season/3'),
        body: season(3, [{ episode_number: 8, air_date: '2026-10-12' }]),
      },
      {
        match: path('/3/tv/9/season/4'),
        body: season(4, [{ episode_number: 1, air_date: '2026-10-26' }, { episode_number: 2 }]),
      },
      {
        match: path('/3/tv/9'),
        body: {
          id: 9,
          name: 'Bluey',
          seasons: [1, 2, 3, 4].map((n) => ({ season_number: n, episode_count: 8 })),
          last_episode_to_air: { air_date: '2026-10-12', season_number: 3, episode_number: 8 },
          next_episode_to_air: { air_date: '2026-10-26', season_number: 4, episode_number: 1 },
        },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'k', fetch, sleep: noSleep, language: 'en-US' });
    const show = await tmdb.getShow(9, [1]);
    expect(show?.schedule).toEqual([
      { season: 3, episode: 8, title: 'Real 8', airDate: '2026-10-12' },
      { season: 4, episode: 1, title: 'Real 1', airDate: '2026-10-26' },
    ]);
    // Seasons fetched for the calendar only don't count as the files' seasons.
    expect(show?.seasons.find((s) => s.season === 3)?.episodes).toEqual([]);
    expect(calls.map((c) => c.url.pathname).sort()).toEqual([
      '/3/tv/9',
      '/3/tv/9/season/1',
      '/3/tv/9/season/3',
      '/3/tv/9/season/4',
    ]);
  });

  it('uses a textless poster when there is no English one', async () => {
    const { fetch } = fakeFetch([
      {
        match: path('/3/movie/7'),
        body: {
          ...tmdbMovie,
          id: 7,
          poster_path: '/ja.jpg',
          images: { posters: [{ file_path: '/textless.jpg', iso_639_1: null }] },
        },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'k', fetch, sleep: noSleep });
    expect((await tmdb.getMovie(7))?.posterRef).toBe('tmdb:w500/textless.jpg');
  });

  it('takes English show and episode titles, without placeholders', async () => {
    const lang = (pathname: string, language: string) => (u: URL) =>
      u.pathname === pathname && u.searchParams.get('language') === language;
    const { fetch } = fakeFetch([
      {
        match: lang('/3/tv/88046', 'nl-NL'),
        body: {
          id: 88046,
          name: '炎炎ノ消防隊',
          original_name: '炎炎ノ消防隊',
          overview: 'Brandweer tegen vlammenmensen.',
          seasons: [{ season_number: 1, episode_count: 3 }],
        },
      },
      {
        match: lang('/3/tv/88046', 'en-US'),
        body: {
          id: 88046,
          name: 'Fire Force',
          original_name: '炎炎ノ消防隊',
          overview: 'English.',
        },
      },
      {
        match: lang('/3/tv/88046/season/1', 'nl-NL'),
        body: {
          season_number: 1,
          name: 'Seizoen 1',
          episodes: [
            { season_number: 1, episode_number: 1, name: 'Shinra Kusakabe', overview: 'NL 1' },
            { season_number: 1, episode_number: 2, name: 'Aflevering 2', overview: '' },
            { season_number: 1, episode_number: 3, name: 'Aflevering 3' },
          ],
        },
      },
      {
        match: lang('/3/tv/88046/season/1', 'en-US'),
        body: {
          season_number: 1,
          name: 'Season 1',
          episodes: [
            { season_number: 1, episode_number: 1, name: 'Shinra Kusakabe Enlists' },
            {
              season_number: 1,
              episode_number: 2,
              name: 'The Heart of a Fire Soldier',
              overview: 'EN 2',
            },
            { season_number: 1, episode_number: 3, name: 'Episode 3' },
          ],
        },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'k', language: 'nl-NL', fetch, sleep: noSleep });
    const show = await tmdb.getShow(88046, [1]);

    expect(show).toMatchObject({
      title: 'Fire Force',
      originalTitle: '炎炎ノ消防隊',
      overview: 'Brandweer tegen vlammenmensen.',
    });
    expect(show?.seasons[0]?.title).toBeUndefined();
    expect(show?.seasons[0]?.episodes).toEqual([
      { season: 1, episode: 1, title: 'Shinra Kusakabe Enlists', overview: 'NL 1' },
      { season: 1, episode: 2, title: 'The Heart of a Fire Soldier', overview: 'EN 2' },
      { season: 1, episode: 3 },
    ]);
  });

  it('falls back to English for empty overviews', async () => {
    const { fetch } = fakeFetch([
      {
        match: (u) => u.pathname === '/3/movie/1' && u.searchParams.get('language') === 'nl-NL',
        body: { ...tmdbMovie, id: 1, overview: '' },
      },
      {
        match: (u) => u.pathname === '/3/movie/1' && u.searchParams.get('language') === 'en-US',
        body: { ...tmdbMovie, id: 1, overview: 'English overview' },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'k', language: 'nl-NL', fetch, sleep: noSleep });
    expect((await tmdb.getMovie(1))?.overview).toBe('English overview');
  });

  it('fetches only the requested seasons and keeps counts for the others', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: path('/3/tv/30984'),
        body: {
          id: 30984,
          name: 'Bleach',
          first_air_date: '2004-10-05',
          external_ids: { tvdb_id: 74796, imdb_id: 'tt0434665' },
          seasons: [
            { season_number: 1, episode_count: 20 },
            { season_number: 2, episode_count: 13 },
          ],
        },
      },
      {
        match: path('/3/tv/30984/season/2'),
        body: { season_number: 2, episodes: [{ season_number: 2, episode_number: 1, name: 'Ep' }] },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'k', fetch, sleep: noSleep });
    const show = await tmdb.getShow(30984, [2, 17]);

    expect(calls.map((c) => c.url.pathname)).toEqual(['/3/tv/30984', '/3/tv/30984/season/2']);
    expect(show?.ids).toEqual({ tmdb: 30984, tvdb: 74796, imdb: 'tt0434665' });
    expect(show?.seasons).toEqual([
      { season: 1, episodeCount: 20, episodes: [] },
      { season: 2, episodeCount: 13, episodes: [{ season: 2, episode: 1, title: 'Ep' }] },
    ]);
  });
});

describe('TvmazeProvider', () => {
  const show = {
    id: 82,
    name: 'Game of Thrones',
    premiered: '2011-04-17',
    summary: '<p>Based on the <b>bestselling</b> book series &amp; more.</p>',
    genres: ['Drama'],
    rating: { average: 8.9 },
    averageRuntime: 60,
    status: 'Ended',
    image: { original: 'https://static.tvmaze.com/uploads/images/original_untouched/1/1.jpg' },
    externals: { thetvdb: 121361, imdb: 'tt0944947' },
    _embedded: {
      episodes: [
        {
          season: 1,
          number: 1,
          name: 'Winter Is Coming',
          airdate: '2011-04-17',
          summary: '<p>Ned…</p>',
        },
        { season: 1, number: null, name: 'Special' },
        { season: 2, number: 1, name: 'The North Remembers' },
        { season: 9, number: 2, name: 'Later', airdate: '2026-12-01' },
        { season: 9, number: 1, name: 'Soon', airdate: '2026-11-01' },
      ],
      cast: [{ person: { name: 'Peter Dinklage' }, character: { name: 'Tyrion' } }],
    },
  };

  it('maps a show with its episodes and skips unnumbered specials', async () => {
    const { fetch } = fakeFetch([{ match: path('/shows/82'), body: show }]);
    const tvmaze = new TvmazeProvider({
      fetch,
      sleep: noSleep,
      now: () => Date.parse('2026-10-18T12:00:00Z'),
    });
    const result = await tvmaze.getShow(82, [1]);
    // The calendar: numbered episodes within a year, also of other seasons.
    expect(result?.schedule).toEqual([
      { season: 9, episode: 2, title: 'Later', airDate: '2026-12-01' },
      { season: 9, episode: 1, title: 'Soon', airDate: '2026-11-01' },
    ]);
    // The first episode that has not aired yet.
    expect(result?.nextEpisode).toEqual({
      season: 9,
      episode: 1,
      title: 'Soon',
      airDate: '2026-11-01',
    });

    expect(result).toMatchObject({
      provider: 'tvmaze',
      title: 'Game of Thrones',
      year: 2011,
      releaseDate: '2011-04-17',
      overview: 'Based on the bestselling book series & more.',
      rating: 8.9,
      runtimeMinutes: 60,
      posterRef: 'tvmaze:uploads/images/original_untouched/1/1.jpg',
      cast: [{ name: 'Peter Dinklage', character: 'Tyrion', order: 0 }],
      ids: { tvmaze: 82, tvdb: 121361, imdb: 'tt0944947' },
    });
    expect(result?.seasons).toEqual([
      {
        season: 1,
        episodeCount: 1,
        episodes: [
          {
            season: 1,
            episode: 1,
            title: 'Winter Is Coming',
            overview: 'Ned…',
            airDate: '2011-04-17',
          },
        ],
      },
    ]);
  });

  it('looks up shows by TVDB id', async () => {
    const { fetch, calls } = fakeFetch([{ match: path('/lookup/shows'), body: { id: 82 } }]);
    const tvmaze = new TvmazeProvider({ fetch, sleep: noSleep });
    expect(await tvmaze.findShow({ tvdb: 121361 })).toBe(82);
    expect(calls[0]?.url.search).toBe('?thetvdb=121361');
  });

  it('strips HTML from summaries', () => {
    expect(stripHtml('<p>One</p><p>Two<br>Three &quot;x&quot;</p>')).toBe('One\n\nTwo\nThree "x"');
    expect(stripHtml('<p></p>')).toBeUndefined();
  });
});

describe('MetadataService', () => {
  it('uses an id hint without searching', async () => {
    const { fetch, calls } = fakeFetch([{ match: path('/3/movie/27205'), body: tmdbMovie }]);
    const service = new MetadataService({
      tmdb: new TmdbProvider({ apiKey: 'k', fetch, sleep: noSleep }),
    });
    const result = await service.matchMovie({ title: 'whatever', ids: { tmdb: 27205 } });
    expect(result).toMatchObject({ status: 'matched', metadata: { id: 27205 }, sources: ['tmdb'] });
    expect(calls).toHaveLength(1);
  });

  it('retries with alternative titles', async () => {
    const { fetch } = fakeFetch([
      {
        match: (u) =>
          u.pathname === '/3/search/movie' &&
          u.searchParams.get('query') === 'The Punisher: One Last Kill',
        body: {
          results: [{ id: 9, title: 'The Punisher: One Last Kill', release_date: '2026-05-12' }],
        },
      },
      { match: path('/3/search/movie'), body: { results: [] } },
      {
        match: path('/3/movie/9'),
        body: { ...tmdbMovie, id: 9, title: 'The Punisher: One Last Kill' },
      },
    ]);
    const service = new MetadataService({
      tmdb: new TmdbProvider({ apiKey: 'k', fetch, sleep: noSleep }),
    });
    const result = await service.matchMovie({
      title: 'A Marvel Television Special Presentation - The Punisher - One Last Kill',
      year: 2026,
      ids: {},
    });
    expect(result).toMatchObject({ status: 'matched', metadata: { id: 9 } });
  });

  it('reports movies as unmatched without a TMDB key', async () => {
    const service = new MetadataService({
      tvmaze: new TvmazeProvider({ fetch: fakeFetch([]).fetch }),
    });
    expect(await service.matchMovie({ title: 'Alpha', year: 2026, ids: {} })).toEqual({
      status: 'unmatched',
      reason: 'TMDB_API_KEY is not set',
    });
  });

  it('fills seasons TMDB does not know from TVmaze', async () => {
    const tmdbFetch = fakeFetch([
      {
        match: path('/3/search/tv'),
        body: { results: [{ id: 30984, name: 'Bleach', first_air_date: '2004-10-05' }] },
      },
      {
        match: path('/3/tv/30984'),
        body: {
          id: 30984,
          name: 'Bleach',
          first_air_date: '2004-10-05',
          external_ids: { tvdb_id: 74796 },
          seasons: [{ season_number: 1, episode_count: 20 }],
        },
      },
    ]);
    const tvmazeFetch = fakeFetch([
      { match: path('/lookup/shows'), body: { id: 1000 } },
      {
        match: path('/shows/1000'),
        body: {
          id: 1000,
          name: 'Bleach',
          _embedded: { episodes: [{ season: 17, number: 1, name: 'The Blood Warfare' }] },
        },
      },
    ]);
    const service = new MetadataService({
      tmdb: new TmdbProvider({ apiKey: 'k', fetch: tmdbFetch.fetch, sleep: noSleep }),
      tvmaze: new TvmazeProvider({ fetch: tvmazeFetch.fetch, sleep: noSleep }),
    });

    const result = await service.matchShow({ title: 'Bleach', ids: {}, seasons: [17] });

    expect(result.status).toBe('matched');
    if (result.status !== 'matched') return;
    expect(result.sources).toEqual(['tmdb', 'tvmaze']);
    expect(result.metadata.ids).toMatchObject({ tmdb: 30984, tvdb: 74796, tvmaze: 1000 });
    expect(result.metadata.seasons.find((s) => s.season === 17)?.episodes[0]?.title).toBe(
      'The Blood Warfare',
    );
    expect(tvmazeFetch.calls[0]?.url.search).toBe('?thetvdb=74796');
  });

  it('falls back to TVmaze for shows when TMDB is not configured', async () => {
    const { fetch } = fakeFetch([
      {
        match: path('/search/shows'),
        body: [{ show: { id: 5, name: 'Agent from Above', premiered: '2025-01-01' } }],
      },
      {
        match: path('/shows/5'),
        body: { id: 5, name: 'Agent from Above', _embedded: { episodes: [] } },
      },
    ]);
    const service = new MetadataService({ tvmaze: new TvmazeProvider({ fetch, sleep: noSleep }) });
    const result = await service.matchShow({ title: 'Agent from Above', ids: {}, seasons: [1] });
    expect(result).toMatchObject({ status: 'matched', sources: ['tvmaze'], metadata: { id: 5 } });
  });
});

describe('assignAbsoluteNumbers', () => {
  it('numbers across regular seasons, skipping specials', () => {
    const show = {
      seasons: [
        { season: 0, episodeCount: 3, episodes: [{ season: 0, episode: 1 }] },
        { season: 1, episodeCount: 12, episodes: [] },
        { season: 2, episodeCount: 12, episodes: [{ season: 2, episode: 1 }] },
      ],
    } as unknown as ShowMetadata;
    assignAbsoluteNumbers(show);
    expect(show.seasons[2]?.episodes[0]?.absolute).toBe(13);
    expect(show.seasons[0]?.episodes[0]?.absolute).toBeUndefined();
  });
});
