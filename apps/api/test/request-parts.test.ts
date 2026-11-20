// "Ontdekken" with actors and seasons, and requests for some seasons or
// episodes of a show: a fake TMDB and a fake Sonarr over HTTP, against PostgreSQL.

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { TmdbProvider } from '../src/metadata/tmdb.js';
import { NotificationService } from '../src/notifications/service.js';
import { SonarrClient } from '../src/requests/arr.js';
import { DiscoverService } from '../src/requests/discover.js';
import { matchEpisode } from '../src/requests/parts.js';
import { RequestService } from '../src/requests/service.js';
import { TEST_AUTH } from './auth-helpers.js';

describe('matchEpisode', () => {
  const sonarr = [
    { id: 1, seasonNumber: 1, episodeNumber: 12, airDate: '2025-08-25' },
    { id: 2, seasonNumber: 1, episodeNumber: 13, airDate: '2025-09-01' },
    { id: 3, seasonNumber: 1, episodeNumber: 14, airDate: '2025-09-08' },
    { id: 4, seasonNumber: 2, episodeNumber: 1, airDate: '2026-01-01' },
    { id: 5, seasonNumber: 2, episodeNumber: 2, airDate: '2026-01-01' },
  ];
  it('links TMDB and TheTVDB numbers by the air date, else by the numbers', () => {
    // TMDB's S2E1 is TheTVDB's S1E13.
    expect(
      matchEpisode({ seasonNumber: 2, episodeNumber: 1, airDate: '2025-09-01' }, sonarr)?.id,
    ).toBe(2);
    // Two that day: the one with the same numbers.
    expect(
      matchEpisode({ seasonNumber: 2, episodeNumber: 2, airDate: '2026-01-01' }, sonarr)?.id,
    ).toBe(5);
    expect(matchEpisode({ seasonNumber: 1, episodeNumber: 14 }, sonarr)?.id).toBe(3);
    expect(matchEpisode({ seasonNumber: 3, episodeNumber: 1 }, sonarr)).toBeUndefined();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const KEY = 'arr-test-key';

/** TMDB: a show with two seasons, and a film, with their actors. */
function fakeTmdb(url: string): unknown {
  const { pathname } = new URL(url);
  const path = pathname.replace(/^\/3/, '');
  const cast = {
    cast: [
      { name: 'Ada Actrice', character: 'Hoofdrol', profile_path: '/ada.jpg', order: 0 },
      { name: 'Bob Bijrol', order: 1 },
    ],
  };
  if (path === '/tv/500') {
    return {
      id: 500,
      name: 'The Show',
      first_air_date: '2025-01-01',
      original_language: 'en',
      genres: [{ id: 18, name: 'Drama' }],
      number_of_seasons: 2,
      credits: cast,
      seasons: [
        { season_number: 0, name: 'Specials', episode_count: 1 },
        { season_number: 1, name: 'Season 1', episode_count: 3, air_date: '2025-01-01' },
        { season_number: 2, name: 'Season 2', episode_count: 2, air_date: '2025-09-01' },
      ],
    };
  }
  if (path === '/tv/500/season/1') {
    return {
      season_number: 1,
      name: 'Season 1',
      episodes: [1, 2, 3].map((n) => ({
        season_number: 1,
        episode_number: n,
        name: `Episode ${n}`,
        air_date: `2025-01-0${n}`,
      })),
    };
  }
  if (path === '/tv/500/season/2') {
    return {
      season_number: 2,
      episodes: [
        { season_number: 2, episode_number: 1, name: 'Back', air_date: '2025-09-01' },
        { season_number: 2, episode_number: 2, name: 'Later', air_date: '2099-01-01' },
      ],
    };
  }
  if (path === '/tv/500/external_ids') return { tvdb_id: 900 };
  if (path === '/movie/77') {
    return { id: 77, title: 'A Film', release_date: '2020-01-01', credits: cast, genres: [] };
  }
  return undefined;
}

describe.skipIf(!databaseUrl)('requests for seasons and episodes (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let service: RequestService;
  let server: Server;
  let showId = '';
  let sonarrUrl = '';
  let seasonId = '';
  const sonarrCalls: { method: string; path: string; body?: unknown }[] = [];
  let series: Record<string, unknown> | undefined;
  /** Looks at the show before Sonarr is done adding it (it then still has addOptions). */
  let adding = 0;
  let addingLooks = 0;
  let admin = { id: '', cookie: '' };
  let member = { id: '', cookie: '' };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });

  /** Sonarr numbers it like TheTVDB: one season of 13, TMDB's S2E1 is S1E13. */
  const sonarrEpisodes = () => [
    ...[1, 2, 3].map((n) => ({
      id: 100 + n,
      seasonNumber: 1,
      episodeNumber: n,
      airDate: `2025-01-0${n}`,
      monitored: false,
    })),
    { id: 113, seasonNumber: 1, episodeNumber: 13, airDate: '2025-09-01', monitored: false },
  ];
  /** What Sonarr has: nothing until it filled the show in after adding it. */
  let episodes: ReturnType<typeof sonarrEpisodes> = [];
  const followed = () => episodes.filter((e) => e.monitored).map((e) => e.id);

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "User", "Session", "Notification", "MyListEntry", "AppSetting", "MediaRequest" CASCADE',
    );

    server = createServer((request, response) => {
      const send = (status: number, body?: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(body === undefined ? '' : JSON.stringify(body));
      };
      if (request.headers['x-api-key'] !== KEY) return send(401, { message: 'Unauthorized' });
      const url = new URL(request.url ?? '/', 'http://x');
      const path = url.pathname.replace(/^\/sonarr\/api\/v3/, '');
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        sonarrCalls.push({ method: request.method ?? 'GET', path, body });
        if (path === '/system/status') return send(200, { version: '4.0.14' });
        if (path === '/qualityprofile') return send(200, [{ id: 4, name: 'HD-1080p' }]);
        if (path === '/rootfolder') return send(200, [{ path: 'D:\\Series' }]);
        if (path === '/languageprofile') return send(404);
        if (path === '/series/lookup') {
          return send(200, [
            {
              title: 'The Show',
              tvdbId: 900,
              ...(series && { id: 1 }),
              seasons: [{ seasonNumber: 1, monitored: true }],
            },
          ]);
        }
        if (path === '/series' && request.method === 'POST') {
          series = { ...body, id: 1 };
          episodes = [];
          return send(201, series);
        }
        if (path === '/series/1' && request.method === 'GET') {
          // As Sonarr: it fills in the episodes, scans the folder, and only
          // then applies addOptions (monitor: none unmonitors every episode).
          if (series?.addOptions) {
            addingLooks++;
            if (episodes.length === 0) episodes = sonarrEpisodes();
            if (--adding < 0) {
              for (const e of episodes) e.monitored = false;
              delete series.addOptions;
            }
          }
          return send(200, series);
        }
        if (path === '/series/1' && request.method === 'PUT') {
          // A season that turns monitored: all its episodes too.
          const before = (series?.seasons ?? []) as { seasonNumber: number; monitored: boolean }[];
          for (const season of body.seasons as { seasonNumber: number; monitored: boolean }[]) {
            const was = before.find((b) => b.seasonNumber === season.seasonNumber)?.monitored;
            if (season.monitored && !was) {
              for (const e of episodes)
                if (e.seasonNumber === season.seasonNumber) e.monitored = true;
            }
          }
          series = body;
          return send(202, series);
        }
        if (path === '/episode') return send(200, episodes);
        if (path === '/episode/monitor') {
          for (const e of episodes)
            if (body.episodeIds.includes(e.id)) e.monitored = body.monitored;
          return send(202, []);
        }
        if (path === '/command') return send(201, { id: 9, name: body.name });
        return send(404, { message: `no ${path}` });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sonarrUrl = `${base}/sonarr`;

    const tmdb = new TmdbProvider({
      apiKey: 'tmdb-key',
      language: 'nl-NL',
      fetch: (async (input: string | URL) => {
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
      sonarr: new SonarrClient({ url: `${base}/sonarr`, apiKey: KEY, pollMs: 0 }),
      notifications,
    });
    app = await buildApp({
      checkDatabase: async () => {},
      services: {
        prisma,
        scanner: {},
        metadata: {},
        images: {},
        mediaRoot: '/media',
        notifications,
        requests: service,
        discover: new DiscoverService({ requests: service }),
      } as unknown as AppServices,
      auth: TEST_AUTH,
    });

    // In the library: S1E1 and S1E2.
    const library = await prisma.library.create({
      data: { name: 'Series', type: 'SHOWS', path: 'Series' },
    });
    const show = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'SHOW',
        path: 'Series/The Show',
        title: 'The Show',
        sortTitle: 'the show',
        tmdbId: 500,
        metadataStatus: 'MATCHED',
      },
    });
    showId = show.id;
    const season = await prisma.season.create({ data: { mediaItemId: show.id, seasonNumber: 1 } });
    seasonId = season.id;
    for (const n of [1, 2]) await addEpisode(1, n, `2025-01-0${n}`);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Beheer', username: 'beheer', password: 'een-lang-wachtwoord' },
    });
    admin = {
      id: setup.json<{ user: { id: string } }>().user.id,
      cookie: String(setup.headers['set-cookie']).split(';')[0] ?? '',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(admin),
      payload: { displayName: 'Bram', username: 'bram', password: 'bram-wachtwoord-1' },
    });
    member.id = created.json<{ id: string }>().id;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'bram', password: 'bram-wachtwoord-1' },
    });
    member = { ...member, cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' };
  });

  async function addEpisode(seasonNumber: number, episodeNumber: number, airDate: string) {
    const season = await prisma.season.upsert({
      where: { mediaItemId_seasonNumber: { mediaItemId: showId, seasonNumber } },
      create: { mediaItemId: showId, seasonNumber },
      update: {},
    });
    await prisma.episode.create({
      data: {
        seasonId: season.id,
        episodeNumber,
        airDate: new Date(`${airDate}T00:00:00Z`),
        files: {
          create: {
            path: `Series/The Show/S${seasonNumber}E${episodeNumber}.mkv`,
            size: 1n,
            modifiedAt: new Date(),
          },
        },
      },
    });
  }

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    server?.close();
  });

  it('shows the actors and the seasons, with what is here', async () => {
    const details = (await app.inject({ url: '/api/discover/show/500', ...as(member) })).json();
    expect(details.itemId).toBe(showId);
    expect(details.cast).toEqual([
      {
        name: 'Ada Actrice',
        character: 'Hoofdrol',
        profileUrl: expect.stringContaining('/api/images/'),
      },
      { name: 'Bob Bijrol' },
    ]);
    expect(details.seasonList).toEqual([
      expect.objectContaining({ seasonNumber: 1, episodeCount: 3, inLibrary: 2, requested: false }),
      expect.objectContaining({ seasonNumber: 2, episodeCount: 2, inLibrary: 0, requested: false }),
    ]);
    const film = (await app.inject({ url: '/api/discover/movie/77', ...as(member) })).json();
    expect(film.cast.map((c: { name: string }) => c.name)).toEqual(['Ada Actrice', 'Bob Bijrol']);
    expect(film.seasonList).toBeUndefined();

    const season = (
      await app.inject({ url: '/api/discover/show/500/season/2', ...as(member) })
    ).json();
    expect(season.episodes).toEqual([
      expect.objectContaining({
        episodeNumber: 1,
        title: 'Back',
        inLibrary: false,
        upcoming: false,
      }),
      expect.objectContaining({ episodeNumber: 2, upcoming: true, requested: false }),
    ]);
    const first = (
      await app.inject({ url: '/api/discover/show/500/season/1', ...as(member) })
    ).json();
    expect(first.episodes.map((e: { inLibrary: boolean }) => e.inLibrary)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('takes a season and single episodes of a show that is here, in one waiting request', async () => {
    const ask = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/requests', ...as(member), payload });
    const whole = await ask({ kind: 'show', tmdbId: 500 });
    expect(whole.statusCode).toBe(409);
    const here = await ask({
      kind: 'show',
      tmdbId: 500,
      episodes: [{ seasonNumber: 1, episodeNumber: 2 }],
    });
    expect(here.statusCode).toBe(409);

    const season = await ask({ kind: 'show', tmdbId: 500, seasons: [1] });
    expect(season.statusCode).toBe(201);
    expect(season.json()).toMatchObject({ status: 'PENDING', seasons: [1] });
    const stored = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: season.json().id } });
    // Only what is missing: S1E3.
    expect(stored.episodes).toEqual([{ seasonNumber: 1, episodeNumber: 3, airDate: '2025-01-03' }]);

    const episode = await ask({
      kind: 'show',
      tmdbId: 500,
      episodes: [{ seasonNumber: 2, episodeNumber: 1 }],
    });
    expect(episode.json()).toMatchObject({
      id: season.json().id,
      seasons: [1],
      episodes: [{ seasonNumber: 2, episodeNumber: 1 }],
    });
    const adminInbox = await prisma.notification.findMany({ where: { userId: admin.id } });
    expect(adminInbox.map((n) => n.title)).toContain('Nieuw verzoek: The Show (2025) · Seizoen 1');
    expect(adminInbox[0]?.body).toBe(
      'Bram vraagt seizoen 1 van deze serie aan. Keur het goed of wijs het af onder Verzoeken.',
    );

    const seasons = (await app.inject({ url: '/api/discover/show/500', ...as(member) })).json();
    expect(seasons.seasonList[0].requested).toBe(true);
    // The card stays "not asked for": only parts are.
    expect(seasons.request).toBeUndefined();
    const list = (
      await app.inject({ url: '/api/discover/show/500/season/2', ...as(member) })
    ).json();
    expect(list.episodes[0].requested).toBe(true);
  });

  it('has Sonarr follow and search only those episodes', async () => {
    const [request] = await prisma.mediaRequest.findMany();
    adding = 2;
    const approved = await app.inject({
      method: 'POST',
      url: `/api/requests/${request?.id}/approve`,
      ...as(admin),
    });
    expect(approved.json()).toMatchObject({ status: 'APPROVED' });
    const added = sonarrCalls.find((c) => c.method === 'POST' && c.path === '/series');
    expect(added?.body).toMatchObject({
      tvdbId: 900,
      monitored: true,
      seasons: [{ seasonNumber: 1, monitored: false }],
      addOptions: { monitor: 'none', searchForMissingEpisodes: false },
    });
    // Waited until Sonarr was done adding: following before that is undone.
    expect(addingLooks).toBe(3);
    expect(followed()).toEqual([101, 102, 103, 113]);
    expect(
      sonarrCalls.find((c) => c.method === 'PUT' && c.path === '/series/1')?.body,
    ).toMatchObject({ seasons: [{ seasonNumber: 1, monitored: true }] });
    // S1E3, and TMDB's S2E1 = Sonarr's S1E13 (by its air date).
    expect(sonarrCalls.find((c) => c.path === '/episode/monitor')?.body).toEqual({
      episodeIds: [103, 113],
      monitored: true,
    });
    expect(sonarrCalls.find((c) => c.path === '/command')?.body).toEqual({
      name: 'EpisodeSearch',
      episodeIds: [103, 113],
    });
  });

  it('follows the episodes later when Sonarr takes long to add a show', async () => {
    series = undefined;
    // Sonarr is busy until the test says it is done.
    adding = 1_000_000;
    const slow = new RequestService({
      prisma,
      tmdb: service.tmdb(),
      sonarr: new SonarrClient({ url: sonarrUrl, apiKey: KEY, pollMs: 10 }),
      sonarrWaitMs: { now: 0, later: 5000 },
    });
    const request = await prisma.mediaRequest.create({
      data: {
        kind: 'SHOW',
        tmdbId: 500,
        title: 'The Show',
        seasons: [],
        episodes: [{ seasonNumber: 2, episodeNumber: 1, airDate: '2025-09-01' }],
      },
    });
    const approved = await slow.approve(request.id, { id: admin.id, name: 'Beheer' });
    expect(approved).toMatchObject({
      status: 'APPROVED',
      reason: 'Sonarr voegt de serie nog toe; de afleveringen worden gevolgd zodra dat klaar is',
    });
    expect(followed()).toEqual([]);
    adding = 0;
    await slow.settled();
    expect(followed()).toEqual([113]);
    expect(
      await prisma.mediaRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).toMatchObject({ status: 'APPROVED', reason: null });
    // The show is followed too: else Sonarr doesn't pick up a later release by itself.
    expect(series).toMatchObject({ monitored: true });
    await prisma.mediaRequest.delete({ where: { id: request.id } });
  });

  it('is here once every episode it covers is', async () => {
    await addEpisode(1, 3, '2025-01-03');
    expect(await service.checkAvailable()).toBe(0);
    // Sonarr names it S01E13; the air date links it to TMDB's S2E1.
    await addEpisode(1, 13, '2025-09-01');
    expect(await service.checkAvailable()).toBe(1);
    const inbox = await prisma.notification.findMany({
      where: { userId: member.id, type: 'request-update' },
      orderBy: { id: 'asc' },
    });
    expect(inbox.at(-1)?.title).toBe('Staat klaar: The Show (Seizoen 1 · S2 · A1)');
    void seasonId;
  });
});
