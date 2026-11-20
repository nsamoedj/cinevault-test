// Sonarr and Radarr: the scan queue, which library a payload is about, and the
// webhook route against a real PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { librariesFor, payloadPaths } from '../src/routes/hooks.js';
import { ScanQueue } from '../src/scanQueue.js';
import type { ScanRequest } from '../src/scanner/scanner.js';
import { TEST_AUTH } from './auth-helpers.js';

const TOKEN = 'webhook-token-0123456789abcdef0123456789abcdef';

// Shortened from what Sonarr and Radarr (v4/v5) send, with Windows paths.
const sonarrImport = {
  eventType: 'Download',
  isUpgrade: false,
  series: { id: 7, title: 'Bleach', path: 'D:\\Anime\\Bleach', tvdbId: 74796 },
  episodes: [{ id: 1, episodeNumber: 1, seasonNumber: 17, title: 'The Blood Warfare' }],
  episodeFile: {
    id: 9,
    relativePath: 'Season 17\\Bleach - S17E01 - The Blood Warfare WEBDL-2160p.mkv',
    path: 'D:\\Anime\\Bleach\\Season 17\\Bleach - S17E01 - The Blood Warfare WEBDL-2160p.mkv',
  },
};
const radarrImport = {
  eventType: 'Download',
  movie: { id: 3, title: 'Coco', folderPath: 'D:\\Movies\\Coco (2017)', tmdbId: 354912 },
  movieFile: {
    relativePath: 'Coco (2017) Bluray-2160p.mkv',
    path: 'D:\\Movies\\Coco (2017)\\Coco (2017) Bluray-2160p.mkv',
  },
};

describe('which library', () => {
  const libraries = [
    { id: 'm', path: 'Movies', type: 'MOVIES' },
    { id: 's', path: 'Series', type: 'SHOWS' },
    { id: 'a', path: 'Anime', type: 'ANIME' },
  ];

  it('finds the paths in a payload', () => {
    expect(payloadPaths(sonarrImport)).toEqual([
      'D:\\Anime\\Bleach',
      'Season 17\\Bleach - S17E01 - The Blood Warfare WEBDL-2160p.mkv',
      'D:\\Anime\\Bleach\\Season 17\\Bleach - S17E01 - The Blood Warfare WEBDL-2160p.mkv',
    ]);
  });

  it('by the folder in the paths, else by kind', () => {
    expect(librariesFor(sonarrImport, libraries)).toEqual(['a']);
    expect(librariesFor(radarrImport, libraries)).toEqual(['m']);
    // Sonarr in Docker, with its own paths: by kind (series and anime).
    expect(librariesFor({ series: { path: '/tv/Bleach' } }, libraries)).toEqual(['s', 'a']);
    expect(librariesFor({ movie: { folderPath: '/films/Coco' } }, libraries)).toEqual(['m']);
    expect(librariesFor({}, libraries)).toEqual([]);
  });
});

describe('scan queue', () => {
  it('takes requests together and waits for a running scan', () => {
    vi.useFakeTimers();
    const started: ScanRequest[] = [];
    let busy = true;
    const queue = new ScanQueue(
      { start: (request = {}) => (busy ? false : (started.push(request), true)) },
      { settleMs: 100, retryMs: 50 },
    );
    queue.request(['a']);
    queue.request(['a']);
    queue.request(['m']);
    vi.advanceTimersByTime(100);
    expect(started).toEqual([]); // a scan runs: nothing lost, tried again
    busy = false;
    vi.advanceTimersByTime(50);
    expect(started).toEqual([{ libraryId: 'a' }]);
    vi.advanceTimersByTime(50);
    expect(started).toEqual([{ libraryId: 'a' }, { libraryId: 'm' }]);
    expect(queue.pending()).toEqual({ all: false, libraryIds: [] });

    queue.request(['s']);
    queue.request();
    vi.advanceTimersByTime(100);
    expect(started.at(-1)).toEqual({});
    expect(queue.pending()).toEqual({ all: false, libraryIds: [] });
    queue.stop();
    vi.useRealTimers();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('webhook route (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  const requested: string[][] = [];

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "Subtitle", "WatchProgress", "User", "Session" CASCADE',
    );
    for (const [name, type] of [
      ['Movies', 'MOVIES'],
      ['Series', 'SHOWS'],
      ['Anime', 'ANIME'],
    ] as const) {
      await prisma.library.create({ data: { name, type, path: name } });
    }
    const queue = { request: (ids: string[] = []) => requested.push(ids) } as unknown as ScanQueue;
    const services = {
      prisma,
      scanner: {},
      metadata: {},
      images: {},
      mediaRoot: '/media',
      scanQueue: queue,
      webhookToken: TOKEN,
    };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: TEST_AUTH,
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const post = (payload: unknown, url = `/api/hooks/arr?token=${TOKEN}`, headers = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });

  it('answers the Test button, and refuses a wrong token', async () => {
    expect((await post({ eventType: 'Test' })).json()).toEqual({ ok: true, test: true });
    expect((await post({ eventType: 'Test' }, '/api/hooks/arr?token=nope')).statusCode).toBe(401);
    expect((await post({ eventType: 'Test' }, '/api/hooks/arr')).statusCode).toBe(401);
    // Basic auth, as Sonarr's username/password fields send it.
    const basic = `Basic ${Buffer.from(`cinevault:${TOKEN}`).toString('base64')}`;
    const viaBasic = await post({ eventType: 'Test' }, '/api/hooks/arr', { authorization: basic });
    expect(viaBasic.statusCode).toBe(200);
    expect(requested).toEqual([]);
  });

  it('asks for a scan of the library a download is in', async () => {
    const anime = await post(sonarrImport);
    expect(anime.statusCode).toBe(202);
    expect(anime.json()).toEqual({ ok: true, scan: true, libraries: ['Anime'] });
    const movie = await post(radarrImport);
    expect(movie.json().libraries).toEqual(['Movies']);
    // A grab is not a file yet.
    expect((await post({ ...sonarrImport, eventType: 'Grab' })).json()).toEqual({
      ok: true,
      scan: false,
    });
    expect(requested).toHaveLength(2);
  });
});
