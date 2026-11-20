// "Verzoeken": search, ask, approve into Radarr/Sonarr (fakes over HTTP),
// decline, withdraw, and "here now". Against a real PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DiscoverDetails } from '@cinevault/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { TmdbProvider } from '../src/metadata/tmdb.js';
import { AnimeMap } from '../src/intro/aniskip.js';
import { NotificationService } from '../src/notifications/service.js';
import { AniListClient, AnimeDiscovery, type AniListMedia } from '../src/requests/anilist.js';
import { RadarrClient, SonarrClient } from '../src/requests/arr.js';
import { DiscoverService } from '../src/requests/discover.js';
import { RequestService } from '../src/requests/service.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const KEY = 'arr-test-key';

/** TMDB's answers, by path (the language decides the description). */
function fakeTmdb(url: string): unknown {
  const { pathname, searchParams } = new URL(url);
  const dutch = searchParams.get('language') === 'nl-NL';
  const path = pathname.replace(/^\/3/, '');
  const movies = [
    {
      id: 438631,
      title: 'Dune',
      release_date: '2021-09-15',
      poster_path: '/dune.jpg',
      overview: dutch ? 'Een woestijnplaneet.' : 'A desert planet.',
      original_language: 'en',
      genre_ids: [878],
    },
    { id: 1, title: 'Dune (1984)', release_date: '1984-12-14', original_language: 'en' },
    { id: 999, title: 'Broken Movie', release_date: '2020-01-01', original_language: 'en' },
  ];
  const shows = [
    {
      id: 37854,
      name: 'One Piece',
      first_air_date: '1999-10-20',
      poster_path: '/op.jpg',
      original_language: 'ja',
      genre_ids: [16, 10759],
    },
    { id: 1399, name: 'Game of Thrones', first_air_date: '2011-04-17', original_language: 'en' },
  ];
  if (path === '/search/movie') return { results: movies };
  if (path === '/search/tv') return { results: shows };
  if (path === '/search/multi') {
    return {
      results: [
        { ...movies[0], media_type: 'movie' },
        { id: 5, name: 'Iemand', media_type: 'person' },
        { ...shows[0], media_type: 'tv' },
      ],
      total_pages: 1,
    };
  }
  // The lists of "Ontdekken".
  if (/^\/(trending\/movie|discover\/movie|movie\/(now_playing|upcoming|popular))/.test(path)) {
    return { results: movies, total_pages: 3, page: Number(searchParams.get('page') ?? 1) };
  }
  if (/^\/(trending\/tv|discover\/tv|tv\/on_the_air)/.test(path)) {
    return { results: shows, total_pages: 2 };
  }
  // Dune's collection and "Meer zoals dit".
  if (path === '/collection/726871') {
    return {
      id: 726871,
      name: 'Dune Collection',
      overview: dutch ? 'De saga van Arrakis.' : 'The saga of Arrakis.',
      backdrop_path: '/dunes.jpg',
      parts: [
        { id: 999999, title: 'Dune: Messiah', release_date: '' },
        { id: 693134, title: 'Dune: Part Two', release_date: '2024-02-27', poster_path: '/d2.jpg' },
        { ...movies[0] },
      ],
    };
  }
  if (path === '/movie/438631/recommendations') {
    return {
      results: [
        { id: 693134, title: 'Dune: Part Two', release_date: '2024-02-27', poster_path: '/d2.jpg' },
        { ...movies[1], poster_path: '/dune84.jpg' },
        // Without a poster: left out.
        { id: 77, title: 'Blank', release_date: '2001-01-01' },
      ],
      total_pages: 1,
    };
  }
  const movie = movies.find((m) => path === `/movie/${m.id}`);
  if (movie) {
    return {
      ...movie,
      ...(movie.id === 438631 && {
        belongs_to_collection: { id: 726871, name: 'Dune Collection' },
      }),
      genres: [{ id: 878, name: dutch ? 'Sciencefiction' : 'Science Fiction' }],
      runtime: 155,
      tagline: 'Beyond fear, destiny awaits.',
      videos: { results: [{ key: 'trailer1', site: 'YouTube', type: 'Trailer', official: true }] },
    };
  }
  const show = shows.find((s) => path === `/tv/${s.id}`);
  if (show) return { ...show, genres: (show.genre_ids ?? []).map((id) => ({ id })) };
  if (path === '/tv/37854/external_ids') return { tvdb_id: 81797 };
  if (path === '/tv/1399/external_ids') return { tvdb_id: 121361 };
  return undefined;
}

const ONE_PIECE: AniListMedia = {
  id: 21,
  idMal: 21,
  format: 'TV',
  title: { english: 'ONE PIECE', romaji: 'ONE PIECE', native: 'ワンピース' },
  synonyms: ['Wan Pisu'],
  startDate: { year: 1999, month: 10, day: 20 },
  coverImage: {
    extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-x.jpg',
  },
};

/**
 * AniList's answers, by what is asked: a search, this season, coming soon
 * (broken), films (none), else One Piece. Down: every request fails.
 */
function fakeAniList(state: { down: boolean; calls: number }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    state.calls++;
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (state.down) return reply(500, { errors: [{ message: 'Internal Server Error' }] });
    const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
    const page = (media: AniListMedia[]) =>
      reply(200, { data: { Page: { pageInfo: { hasNextPage: false }, media } } });
    if (variables.search !== undefined)
      return page(variables.search === 'wan pisu' ? [ONE_PIECE] : []);
    if (variables.status === 'NOT_YET_RELEASED')
      return reply(500, { errors: [{ message: 'Oops' }] });
    if (JSON.stringify(variables.format_in) === '["MOVIE"]') return page([]);
    if (variables.season) {
      // Not in the anime-lists yet: found by a TMDB search, as its show.
      return page([
        { ...ONE_PIECE, id: 999, idMal: null, title: { english: 'One Piece Season 2' } },
      ]);
    }
    return page([ONE_PIECE]);
  }) as typeof fetch;
}

describe.skipIf(!databaseUrl)('requests to Radarr and Sonarr (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let service: RequestService;
  let server: Server;
  let tmdbCalls = 0;
  const anilist = { down: false, calls: 0 };
  const added: { service: string; body: Record<string, unknown> }[] = [];
  let admin = { id: '', cookie: '' };
  let member = { id: '', cookie: '' };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });
  const inbox = (who: { id: string }) =>
    prisma.notification.findMany({ where: { userId: who.id }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "User", "Session", "Notification", "MyListEntry", "AppSetting", "MediaRequest" CASCADE',
    );

    // Radarr under /radarr, Sonarr (v4: no language profiles) under /sonarr.
    server = createServer((request, response) => {
      const send = (status: number, body?: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(body === undefined ? '' : JSON.stringify(body));
      };
      if (request.headers['x-api-key'] !== KEY) return send(401, { message: 'Unauthorized' });
      const url = new URL(request.url ?? '/', 'http://x');
      const [, service, , , ...rest] = url.pathname.split('/');
      const path = `/${rest.join('/')}`;
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        if (path === '/system/status')
          return send(200, { version: service === 'radarr' ? '5.21.1' : '4.0.14' });
        if (path === '/qualityprofile')
          return send(200, [
            { id: 4, name: 'HD-1080p' },
            { id: 7, name: 'Ultra-HD' },
          ]);
        if (path === '/rootfolder') {
          return send(
            200,
            service === 'radarr'
              ? [{ path: 'D:\\Movies', freeSpace: 1e12 }]
              : [{ path: 'D:\\Anime' }, { path: 'D:\\Series' }],
          );
        }
        if (path === '/languageprofile') return send(404);
        if (path === '/movie/lookup/tmdb') {
          const tmdbId = Number(url.searchParams.get('tmdbId'));
          if (tmdbId === 999) return send(404, { message: 'Movie not found' });
          return send(200, { title: 'Dune', tmdbId, year: 2021 });
        }
        if (path === '/series/lookup') {
          const term = url.searchParams.get('term');
          if (term === 'tvdb:81797') return send(200, [{ title: 'One Piece', tvdbId: 81797 }]);
          if (term === 'tvdb:121361')
            return send(200, [{ title: 'Game of Thrones', tvdbId: 121361 }]);
          return send(200, []);
        }
        if ((path === '/movie' || path === '/series') && request.method === 'POST') {
          added.push({ service: service ?? '', body });
          return send(201, { ...body, id: added.length });
        }
        return send(404, { message: `no ${path}` });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tmdb = new TmdbProvider({
      apiKey: 'tmdb-key',
      language: 'nl-NL',
      fetch: (async (input: string | URL) => {
        tmdbCalls++;
        const body = fakeTmdb(String(input));
        return body === undefined
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const notifications = new NotificationService({ prisma, timeZone: 'Europe/Amsterdam' });
    service = new RequestService({
      prisma,
      tmdb,
      radarr: new RadarrClient({ url: `${base}/radarr`, apiKey: KEY }),
      sonarr: new SonarrClient({ url: `${base}/sonarr`, apiKey: KEY }),
      notifications,
    });
    const anime = new AnimeDiscovery({
      client: new AniListClient({ fetch: fakeAniList(anilist) }),
      animeMap: async () =>
        new AnimeMap([
          { anilist_id: 21, mal_id: 21, tvdb_id: 81797, themoviedb_id: { tv: 37854 } },
        ]),
      tmdb: () => tmdb,
    });
    const services = {
      prisma,
      scanner: {},
      metadata: {},
      images: {},
      mediaRoot: '/media',
      notifications,
      requests: service,
      discover: new DiscoverService({ requests: service, anime }),
    };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: TEST_AUTH,
    });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Beheer', username: 'beheer', password: 'een-lang-wachtwoord' },
    });
    admin = {
      id: setup.json<{ user: { id: string } }>().user.id,
      cookie: String(setup.headers['set-cookie']).split(';')[0] ?? '',
    };
    await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(admin),
      payload: { displayName: 'Bram', username: 'bram', password: 'nog-een-wachtwoord' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'bram', password: 'nog-een-wachtwoord' },
    });
    member = {
      id: login.json<{ user: { id: string } }>().user.id,
      cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    };
    // Dune (1984) is here already.
    const library = await prisma.library.create({
      data: { name: 'Movies', type: 'MOVIES', path: 'Movies' },
    });
    await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'MOVIE',
        path: 'Movies/Dune (1984)',
        title: 'Dune',
        sortTitle: 'dune',
        tmdbId: 1,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    server?.close();
    await prisma?.$disconnect();
  });

  it('shows admins the connections and guesses the folders', async () => {
    const config = await app.inject({ url: '/api/requests/config', ...as(admin) });
    expect(config.json()).toMatchObject({
      radarr: { configured: true, ok: true, version: '5.21.1' },
      sonarr: { configured: true, ok: true, version: '4.0.14' },
      autoApprove: false,
      movies: { rootFolderPath: 'D:\\Movies', qualityProfileId: 4 },
      shows: { rootFolderPath: 'D:\\Series', qualityProfileId: 4 },
      anime: { rootFolderPath: 'D:\\Anime', qualityProfileId: 4 },
    });
    expect((await app.inject({ url: '/api/requests/config', ...as(member) })).statusCode).toBe(403);
    // A wrong key says so.
    const wrong = new RequestService({
      prisma,
      radarr: new RadarrClient({ url: 'http://127.0.0.1:1/radarr', apiKey: 'x' }),
    });
    expect((await wrong.config()).radarr).toMatchObject({ configured: true, ok: false });
  });

  it('searches TMDB, with what is here already', async () => {
    const found = await app.inject({
      url: '/api/requests/search?q=dune&kind=movie',
      ...as(member),
    });
    expect(found.json()).toEqual([
      expect.objectContaining({
        tmdbId: 438631,
        title: 'Dune',
        year: 2021,
        overview: 'Een woestijnplaneet.',
        posterUrl: '/api/images/tmdb/w342/dune.jpg',
        anime: false,
      }),
      expect.objectContaining({ tmdbId: 1, itemId: expect.any(String) }),
      expect.objectContaining({ tmdbId: 999 }),
    ]);
    const shows = await app.inject({ url: '/api/requests/search?q=one&kind=show', ...as(member) });
    expect(shows.json<{ anime: boolean }[]>().map((s) => s.anime)).toEqual([true, false]);
    // In the library: nothing to ask for.
    const here = await app.inject({
      method: 'POST',
      url: '/api/requests',
      ...as(member),
      payload: { kind: 'movie', tmdbId: 1 },
    });
    expect(here.statusCode).toBe(409);
    expect(here.json()).toMatchObject({ itemId: expect.any(String) });
  });

  it('waits for an admin, who sends it to Radarr', async () => {
    const asked = await app.inject({
      method: 'POST',
      url: '/api/requests',
      ...as(member),
      payload: { kind: 'movie', tmdbId: 438631 },
    });
    expect(asked.statusCode).toBe(201);
    const request = asked.json<{ id: string }>();
    expect(asked.json()).toMatchObject({
      status: 'PENDING',
      title: 'Dune',
      requestedBy: [{ displayName: 'Bram' }],
    });
    expect(added).toEqual([]);
    expect((await inbox(admin)).at(-1)).toMatchObject({
      type: 'request-new',
      title: 'Nieuw verzoek: Dune (2021)',
      body: expect.stringContaining('Bram vraagt deze film aan'),
    });
    // Members can't approve.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/requests/${request.id}/approve`,
          ...as(member),
        })
      ).statusCode,
    ).toBe(403);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/requests/${request.id}/approve`,
      ...as(admin),
    });
    expect(approved.json()).toMatchObject({ status: 'APPROVED', decidedBy: 'Beheer' });
    expect(added.at(-1)).toEqual({
      service: 'radarr',
      body: expect.objectContaining({
        tmdbId: 438631,
        rootFolderPath: 'D:\\Movies',
        qualityProfileId: 4,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
    });
    expect((await inbox(member)).at(-1)).toMatchObject({
      type: 'request-update',
      title: 'Verzoek goedgekeurd: Dune',
    });
    // Asking again just shows it.
    const again = await app.inject({
      url: '/api/requests/search?q=dune&kind=movie',
      ...as(member),
    });
    expect(again.json<{ request?: { status: string } }[]>()[0]?.request).toMatchObject({
      status: 'APPROVED',
    });
  });

  it('files anime as anime in Sonarr, in the Anime folder', async () => {
    const asked = await app.inject({
      method: 'POST',
      url: '/api/requests',
      ...as(member),
      payload: { kind: 'show', tmdbId: 37854 },
    });
    expect(asked.json()).toMatchObject({ anime: true, status: 'PENDING' });
    await app.inject({
      method: 'POST',
      url: `/api/requests/${asked.json<{ id: string }>().id}/approve`,
      ...as(admin),
    });
    expect(added.at(-1)).toEqual({
      service: 'sonarr',
      body: expect.objectContaining({
        tvdbId: 81797,
        seriesType: 'anime',
        rootFolderPath: 'D:\\Anime',
        addOptions: { monitor: 'all', searchForMissingEpisodes: true },
      }),
    });
    expect(added.at(-1)?.body).not.toHaveProperty('languageProfileId');
  });

  it('declines, can be asked again, and withdrawn', async () => {
    const asked = await app.inject({
      method: 'POST',
      url: '/api/requests',
      ...as(member),
      payload: { kind: 'show', tmdbId: 1399 },
    });
    const id = asked.json<{ id: string }>().id;
    const declined = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/decline`,
      ...as(admin),
      payload: { reason: 'Kijken we op Netflix' },
    });
    expect(declined.json()).toMatchObject({ status: 'DECLINED', reason: 'Kijken we op Netflix' });
    expect((await inbox(member)).at(-1)).toMatchObject({
      title: 'Verzoek afgewezen: Game of Thrones',
      body: 'Beheer: Kijken we op Netflix',
    });
    const again = await app.inject({
      method: 'POST',
      url: '/api/requests',
      ...as(member),
      payload: { kind: 'show', tmdbId: 1399 },
    });
    expect(again.json()).toMatchObject({ id, status: 'PENDING' });
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/requests/${id}`, ...as(member) }))
        .statusCode,
    ).toBe(204);
    expect(await prisma.mediaRequest.findUnique({ where: { id } })).toBeNull();
  });

  it('keeps what Radarr said when it refuses', async () => {
    const asked = await app.inject({
      method: 'POST',
      url: '/api/requests',
      ...as(admin),
      payload: { kind: 'movie', tmdbId: 999 },
    });
    // An admin's own request goes at once; Radarr does not know this one.
    expect(asked.json()).toMatchObject({ status: 'FAILED', reason: 'Radarr: Movie not found' });
  });

  it('approves at once with "automatisch goedkeuren"', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/requests/config',
      ...as(admin),
      payload: { autoApprove: true, movies: { rootFolderPath: 'D:\\Movies', qualityProfileId: 7 } },
    });
    await prisma.mediaRequest.deleteMany({ where: { tmdbId: 999 } });
    const before = added.length;
    // 999 fails in Radarr, but it was sent: no admin needed.
    const asked = await app.inject({
      method: 'POST',
      url: '/api/requests',
      ...as(member),
      payload: { kind: 'movie', tmdbId: 999 },
    });
    expect(asked.json()).toMatchObject({ status: 'FAILED' });
    expect(added.length).toBe(before);
    await app.inject({
      method: 'PUT',
      url: '/api/requests/config',
      ...as(admin),
      payload: { autoApprove: false },
    });
  });

  it('tells whoever asked when it is here, and puts it in their list', async () => {
    const library = await prisma.library.findFirstOrThrow();
    const dune = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'MOVIE',
        path: 'Movies/Dune (2021)',
        title: 'Dune',
        sortTitle: 'dune',
        tmdbId: 438631,
      },
    });
    expect(await service.checkAvailable()).toBe(1);
    expect((await inbox(member)).at(-1)).toMatchObject({
      type: 'request-update',
      title: 'Staat klaar: Dune',
      itemId: dune.id,
    });
    expect(
      await prisma.myListEntry.findUnique({
        where: { userId_mediaItemId: { userId: member.id, mediaItemId: dune.id } },
      }),
    ).not.toBeNull();
    const list = await app.inject({ url: '/api/requests', ...as(member) });
    expect(list.json()).toContainEqual(
      expect.objectContaining({ title: 'Dune', status: 'AVAILABLE', itemId: dune.id }),
    );
    expect(await service.checkAvailable()).toBe(0);
  });

  it('shows rows of new titles to browse, kept for an hour', async () => {
    const before = tmdbCalls;
    const feed = await app.inject({ url: '/api/discover', ...as(member) });
    const rows = feed.json<{
      rows: {
        id: string;
        title: string;
        kind: string;
        items: { title: string; itemId?: string; request?: { status: string } }[];
      }[];
    }>().rows;
    expect(rows.map((r) => r.id)).toEqual([
      'movies-streaming',
      'movies-trending',
      'shows-new',
      'shows-trending',
      'anime-new',
      'anime-trending',
      'movies-theaters',
      'movies-upcoming',
      // anime-upcoming: AniList failed and there is nothing to fall back on; anime-movies: empty.
      'shows-airing',
      'anime-popular',
      'movies-popular',
    ]);
    expect(rows[0]).toMatchObject({ title: 'Nieuw te streamen', kind: 'movie' });
    // Titles without a poster are left out; what is here or asked for says so.
    expect(rows[0]?.items).toEqual([
      expect.objectContaining({
        title: 'Dune',
        itemId: expect.any(String),
        request: { id: expect.any(String), status: 'AVAILABLE' },
      }),
    ]);
    expect(rows[2]?.items[0]).toMatchObject({ title: 'One Piece', anime: true });
    // The anime rows from AniList, as TMDB titles: by the anime-lists, else a
    // TMDB search (a later season becomes its show).
    const anime = (id: string) => rows.find((r) => r.id === id)?.items;
    expect(anime('anime-trending')).toEqual([
      expect.objectContaining({
        kind: 'show',
        tmdbId: 37854,
        title: 'ONE PIECE',
        anime: true,
        posterUrl: '/api/images/anilist/media/anime/cover/large/bx21-x.jpg',
      }),
    ]);
    expect(anime('anime-new')).toEqual([
      expect.objectContaining({ tmdbId: 37854, title: 'One Piece Season 2' }),
    ]);
    const calls = tmdbCalls - before;
    expect(calls).toBeGreaterThan(0);
    await app.inject({ url: '/api/discover', ...as(member) });
    expect(tmdbCalls - before).toBe(calls);
  });

  it('browses a row page by page, and searches movies and shows at once', async () => {
    const page = await app.inject({
      url: '/api/discover/rows/movies-popular?page=2',
      ...as(member),
    });
    expect(page.json()).toMatchObject({
      id: 'movies-popular',
      title: 'Populaire films',
      page: 2,
      totalPages: 3,
    });
    expect((await app.inject({ url: '/api/discover/rows/nope', ...as(member) })).statusCode).toBe(
      404,
    );
    const found = await app.inject({ url: '/api/discover/search?q=dune', ...as(member) });
    expect(
      found
        .json<{ items: { kind: string; title: string }[] }>()
        .items.map((i) => [i.kind, i.title]),
    ).toEqual([
      ['movie', 'Dune'],
      ['show', 'One Piece'],
    ]);
    // A romaji title TMDB doesn't know: AniList's answer goes first.
    const romaji = await app.inject({ url: '/api/discover/search?q=wan%20pisu', ...as(member) });
    expect(
      romaji
        .json<{ items: { kind: string; title: string }[] }>()
        .items.map((i) => [i.kind, i.title]),
    ).toEqual([
      ['show', 'One Piece'],
      ['movie', 'Dune'],
    ]);
  });

  it('falls back on TMDB when AniList does not answer', async () => {
    anilist.down = true;
    try {
      // A page not seen before (the first ones are kept for an hour).
      const popular = await app.inject({
        url: '/api/discover/rows/anime-popular?page=2',
        ...as(member),
      });
      expect(popular.statusCode).toBe(200);
      expect(popular.json<{ items: { title: string }[] }>().items.map((i) => i.title)).toEqual([
        'One Piece',
      ]);
      // A row only AniList has: an error that says so.
      const trending = await app.inject({
        url: '/api/discover/rows/anime-trending?page=2',
        ...as(member),
      });
      expect(trending.statusCode).toBe(502);
      expect(trending.json<{ error: string }>().error).toContain('AniList');
      // A search still works, with TMDB's results.
      const found = await app.inject({ url: '/api/discover/search?q=ruffy', ...as(member) });
      expect(found.statusCode).toBe(200);
      expect(found.json<{ items: unknown[] }>().items).toHaveLength(2);
    } finally {
      anilist.down = false;
    }
  });

  it("gives a title's details, with the trailer", async () => {
    const details = await app.inject({ url: '/api/discover/movie/438631', ...as(member) });
    expect(details.json()).toMatchObject({
      kind: 'movie',
      title: 'Dune',
      overview: 'Een woestijnplaneet.',
      genres: ['Sciencefiction'],
      runtimeMinutes: 155,
      trailerKey: 'trailer1',
      itemId: expect.any(String),
      collection: {
        id: 726871,
        name: 'Dune Collection',
        overview: 'De saga van Arrakis.',
        backdropUrl: '/api/images/tmdb/w1280/dunes.jpg',
        owned: 1,
      },
    });
    const { collection, similar } = details.json<DiscoverDetails>();
    // In the order they came out; no date yet last.
    expect(collection?.parts.map((p) => [p.title, Boolean(p.itemId)])).toEqual([
      ['Dune', true],
      ['Dune: Part Two', false],
      ['Dune: Messiah', false],
    ]);
    expect(similar?.map((s) => [s.title, Boolean(s.itemId)])).toEqual([
      ['Dune: Part Two', false],
      ['Dune (1984)', true],
    ]);
    // A show has no collection.
    const show = await app.inject({ url: '/api/discover/show/1399', ...as(member) });
    expect(show.json<DiscoverDetails>().collection).toBeUndefined();
    expect((await app.inject({ url: '/api/discover/movie/31337', ...as(member) })).statusCode).toBe(
      404,
    );
  });
});
