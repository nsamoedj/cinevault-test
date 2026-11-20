// Kids profiles (only titles up to their age) and "Wordt gedownload" (the
// queues of Radarr and Sonarr). Units, then the routes against a real
// PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { ageLabel } from '@cinevault/shared';
import { pickAgeRating } from '../src/metadata/age.js';
import type { QueueRecord, RadarrClient, SonarrClient } from '../src/requests/arr.js';
import { DownloadService, groupQueue, timeLeftMs } from '../src/requests/downloads.js';
import { RequestService } from '../src/requests/service.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe('age ratings', () => {
  it('takes Kijkwijzer first, then Germany, the UK and the US', () => {
    expect(
      pickAgeRating([
        { country: 'US', rating: 'PG-13' },
        { country: 'NL', rating: '12' },
      ]),
    ).toEqual({ age: 12, certification: 'NL 12' });
    expect(pickAgeRating([{ country: 'NL', rating: 'AL' }])?.age).toBe(0);
    expect(pickAgeRating([{ country: 'US', rating: 'TV-MA' }])).toEqual({
      age: 17,
      certification: 'US TV-MA',
    });
    expect(pickAgeRating([{ country: 'GB', rating: '12A' }])?.age).toBe(12);
    // Empty and unknown ratings don't count.
    expect(
      pickAgeRating([
        { country: 'NL', rating: '' },
        { country: 'FR', rating: '12' },
        { country: 'US', rating: 'NR' },
      ]),
    ).toBeUndefined();
    expect(ageLabel(0)).toBe('AL');
    expect(ageLabel(16)).toBe('16');
  });
});

describe('the download queue', () => {
  it('reads Radarr and Sonarr times', () => {
    expect(timeLeftMs('00:12:30')).toBe(750_000);
    expect(timeLeftMs('1.02:00:00')).toBe(26 * 3600_000);
    expect(timeLeftMs(undefined)).toBeUndefined();
  });

  it('makes one entry per title, over all its episodes', () => {
    const records: QueueRecord[] = [
      {
        series: { tmdbId: 1399, tvdbId: 121361, title: 'Game of Thrones' },
        episode: { seasonNumber: 1, episodeNumber: 2, title: 'The Kingsroad' },
        size: 1000,
        sizeleft: 500,
        timeleft: '00:10:00',
        status: 'downloading',
        trackedDownloadState: 'downloading',
        trackedDownloadStatus: 'ok',
      },
      {
        series: { tmdbId: 1399, tvdbId: 121361, title: 'Game of Thrones' },
        episode: { seasonNumber: 1, episodeNumber: 1, title: 'Winter Is Coming' },
        size: 1000,
        sizeleft: 0,
        status: 'completed',
        trackedDownloadState: 'importPending',
        trackedDownloadStatus: 'ok',
      },
      {
        series: { tvdbId: 81797, title: 'One Piece' },
        episode: { seasonNumber: 21, episodeNumber: 1 },
        size: 100,
        sizeleft: 100,
        status: 'warning',
        trackedDownloadStatus: 'warning',
        statusMessages: [{ title: 'x', messages: ['Geen bestanden gevonden'] }],
      },
    ];
    const [got, onePiece] = groupQueue('show', records);
    expect(got).toMatchObject({
      kind: 'show',
      tmdbId: 1399,
      title: 'Game of Thrones',
      state: 'downloading',
      progress: 0.75,
      sizeBytes: 2000,
      leftBytes: 500,
      timeLeftMs: 600_000,
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, title: 'Winter Is Coming' },
        { seasonNumber: 1, episodeNumber: 2, title: 'The Kingsroad' },
      ],
    });
    expect(onePiece).toMatchObject({
      tvdbId: 81797,
      state: 'warning',
      message: 'Geen bestanden gevonden',
      progress: 0,
    });
    expect(groupQueue('movie', [{ movie: { tmdbId: 1 }, status: 'failed' }])[0]?.state).toBe(
      'failed',
    );
  });
});

describe.skipIf(!databaseUrl)('kids profiles and downloads (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let admin = '';
  let kid = '';
  const ids: Record<string, string> = {};
  const files: Record<string, string> = {};
  const as = (cookie: string) => ({ headers: { cookie } });
  let radarrQueue: QueueRecord[] = [];
  let radarrCalls = 0;
  let clock = Date.now();

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "WatchProgress", "User", "Session", "Notification", "MyListEntry", "AppSetting", "MediaRequest" CASCADE',
    );
    const radarr = {
      service: 'radarr',
      queue: async () => {
        radarrCalls++;
        return radarrQueue;
      },
    } as unknown as RadarrClient;
    const sonarr = {
      service: 'sonarr',
      queue: async () => {
        throw new Error('Sonarr is down');
      },
    } as unknown as SonarrClient;
    const downloads = new DownloadService({ prisma, radarr, sonarr, now: () => clock });
    const requests = new RequestService({ prisma, radarr, sonarr, downloads });
    const services = {
      prisma,
      scanner: {},
      metadata: {},
      images: {},
      mediaRoot: '/media',
      requests,
      downloads,
    };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: TEST_AUTH,
    });

    const library = await prisma.library.create({
      data: { name: 'Movies', type: 'MOVIES', path: 'Movies' },
    });
    const movie = async (title: string, ageRating: number | null, tmdbId: number) => {
      const item = await prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          type: 'MOVIE',
          path: `Movies/${title}`,
          title,
          sortTitle: title.toLowerCase(),
          genres: ['Animatie'],
          rating: 8,
          ageRating,
          tmdbId,
          metadataStatus: 'MATCHED',
          backdropPath: 'tmdb:w1280/b.jpg',
          overview: `Over ${title}.`,
          addedAt: new Date(),
        },
      });
      ids[title] = item.id;
      const file = await prisma.mediaFile.create({
        data: {
          mediaItemId: item.id,
          path: `Movies/${title}/${title}.mkv`,
          size: 1000n,
          modifiedAt: new Date(),
          durationMs: 3_600_000,
        },
      });
      files[title] = file.id;
    };
    await movie('Kabouter', 0, 10);
    await movie('Avontuur', 9, 11);
    await movie('Spanning', 16, 12);
    await movie('Onbekend', null, 13);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Ouder', username: 'ouder', password: 'ouder-wachtwoord-1' },
    });
    admin = String(setup.headers['set-cookie']).split(';')[0] ?? '';
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(admin),
      payload: { displayName: 'Kind', username: 'kind', password: 'kind-wachtwoord-1', maxAge: 9 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ maxAge: 9 });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'kind', password: 'kind-wachtwoord-1' },
    });
    kid = String(login.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('shows a kids profile only what is rated up to its age', async () => {
    const libraries = (await app.inject({ url: '/api/libraries', ...as(kid) })).json();
    expect(libraries[0].itemCount).toBe(2);
    const libraryId = libraries[0].id as string;
    const list = await app.inject({ url: `/api/libraries/${libraryId}/items`, ...as(kid) });
    expect(
      list
        .json()
        .items.map((i: { title: string }) => i.title)
        .sort(),
    ).toEqual(['Avontuur', 'Kabouter']);
    expect(list.json().items[0].ageRating).toBeDefined();
    const all = await app.inject({ url: `/api/libraries/${libraryId}/items`, ...as(admin) });
    expect(all.json().total).toBe(4);

    const search = await app.inject({ url: '/api/search?q=n', ...as(kid) });
    expect(search.json().map((i: { title: string }) => i.title)).not.toContain('Spanning');
    expect((await app.inject({ url: `/api/items/${ids.Spanning}`, ...as(kid) })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ url: `/api/items/${ids.Onbekend}`, ...as(kid) })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ url: `/api/items/${ids.Avontuur}`, ...as(kid) })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: `/api/items/${ids.Spanning}`, ...as(admin) })).statusCode).toBe(
      200,
    );

    const home = (await app.inject({ url: '/api/home', ...as(kid) })).json();
    const seen = new Set<string>([
      ...home.featured.map((f: { title: string }) => f.title),
      ...home.rows.flatMap((r: { items: { title: string }[] }) => r.items.map((i) => i.title)),
    ]);
    expect([...seen].sort()).toEqual(['Avontuur', 'Kabouter']);
  });

  it("doesn't let a kids profile play, list or ask for what it may not see", async () => {
    expect((await app.inject({ url: `/api/files/${files.Spanning}`, ...as(kid) })).statusCode).toBe(
      404,
    );
    const play = await app.inject({
      method: 'POST',
      url: '/api/playback',
      ...as(kid),
      payload: { fileId: files.Spanning },
    });
    expect(play.statusCode).toBe(404);
    const add = await app.inject({
      method: 'PUT',
      url: `/api/my-list/${ids.Spanning}`,
      ...as(kid),
    });
    expect(add.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/discover', ...as(kid) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/requests', ...as(kid) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/downloads', ...as(kid) })).statusCode).toBe(403);
  });

  it('keeps admins out of kids profiles, and lifts the limit', async () => {
    const me = (await app.inject({ url: '/api/auth/status', ...as(admin) })).json();
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/users/${me.user.id}`,
      ...as(admin),
      payload: { maxAge: 12 },
    });
    expect(bad.statusCode).toBe(400);
    const users = (await app.inject({ url: '/api/users', ...as(admin) })).json();
    const child = users.find((u: { username: string }) => u.username === 'kind');
    const lifted = await app.inject({
      method: 'PATCH',
      url: `/api/users/${child.id}`,
      ...as(admin),
      payload: { maxAge: 16 },
    });
    expect(lifted.json()).toMatchObject({ maxAge: 16 });
    const libraries = (await app.inject({ url: '/api/libraries', ...as(kid) })).json();
    expect(libraries[0].itemCount).toBe(3);
  });

  it('shows what Radarr downloads, on the list and on the title, and survives Sonarr being down', async () => {
    await prisma.mediaRequest.create({
      data: { kind: 'MOVIE', tmdbId: 20, title: 'Gevraagd', status: 'APPROVED' },
    });
    // Later than the queue the earlier title pages asked for.
    clock += 60_000;
    const calls = radarrCalls;
    radarrQueue = [
      {
        movie: { tmdbId: 20, title: 'Gevraagd' },
        size: 4000,
        sizeleft: 1000,
        timeleft: '00:05:00',
        status: 'downloading',
      },
      {
        movie: { tmdbId: 12, title: 'Spanning' },
        size: 100,
        sizeleft: 0,
        status: 'completed',
        trackedDownloadState: 'importing',
      },
    ];
    const list = await app.inject({ url: '/api/downloads', ...as(admin) });
    expect(list.statusCode).toBe(200);
    const entries = list.json();
    expect(entries).toHaveLength(2);
    expect(entries.find((e: { title: string }) => e.title === 'Gevraagd')).toMatchObject({
      kind: 'movie',
      progress: 0.75,
      timeLeftMs: 300_000,
      state: 'downloading',
      requestId: expect.any(String),
    });
    expect(entries.find((e: { title: string }) => e.title === 'Spanning')).toMatchObject({
      itemId: ids.Spanning,
      state: 'importing',
    });
    const requests = (await app.inject({ url: '/api/requests', ...as(admin) })).json();
    expect(requests[0].download).toMatchObject({ progress: 0.75 });
    const item = (await app.inject({ url: `/api/items/${ids.Spanning}`, ...as(admin) })).json();
    expect(item.download).toMatchObject({ state: 'importing' });
    // Asked at most every few seconds, however many ask.
    expect(radarrCalls).toBe(calls + 1);
  });
});
