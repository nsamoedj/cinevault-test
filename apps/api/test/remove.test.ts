// Removing a film, a show, a season or an episode through Radarr and Sonarr
// (fakes over HTTP), as an admin only. Against a real PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RemovePreview, RemoveResult } from '@cinevault/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { RadarrClient, SonarrClient } from '../src/requests/arr.js';
import { RemoveService } from '../src/requests/remove.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const KEY = 'arr-test-key';

describe.skipIf(!databaseUrl)('removing through Radarr and Sonarr (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let server: Server;
  const calls: string[] = [];
  const scans: string[][] = [];
  let admin = { cookie: '' };
  let member = { cookie: '' };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });
  const ids = { movie: '', show: '', season1: '', season2: '', episode: '', movies: '' };

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "User", "Session", "Notification", "MediaRequest" CASCADE',
    );

    // Radarr under /radarr, Sonarr under /sonarr; paths as they see them on Windows.
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
        const body = chunks.length ? Buffer.concat(chunks).toString() : '';
        if (request.method !== 'GET') {
          calls.push(`${service} ${request.method} ${path}${url.search} ${body}`.trim());
        }
        if (service === 'radarr' && path === '/movie' && request.method === 'GET') {
          return send(200, [
            { id: 11, title: 'Other', tmdbId: 5, path: 'D:\\Movies\\Other (2000)' },
            { id: 12, title: 'Dune', tmdbId: 438631, path: 'D:\\Movies\\Dune (2021)' },
          ]);
        }
        if (service === 'sonarr' && path === '/series' && request.method === 'GET') {
          // Sonarr in Docker: other paths than CineVault's; the tvdb id finds it.
          return send(200, [
            { id: 21, title: 'The Office', tvdbId: 73244, path: '/tv/The Office' },
          ]);
        }
        if (service === 'sonarr' && path === '/episodefile') {
          return send(200, [
            { id: 301, seasonNumber: 1, relativePath: 'Season 1/The Office - S01E01.mkv' },
            { id: 302, seasonNumber: 1, relativePath: 'Season 1/The Office - S01E02.mkv' },
            { id: 303, seasonNumber: 2, relativePath: 'Season 2/The Office - S02E01.mkv' },
          ]);
        }
        if (service === 'sonarr' && path === '/episode') {
          return send(200, [
            { id: 401, seasonNumber: 1, episodeNumber: 1, episodeFileId: 301 },
            { id: 402, seasonNumber: 1, episodeNumber: 2, episodeFileId: 302 },
            { id: 403, seasonNumber: 2, episodeNumber: 1, episodeFileId: 303 },
          ]);
        }
        // Radarr and Sonarr answer a DELETE with 200 and no body.
        if (request.method === 'DELETE' || request.method === 'PUT') return send(200);
        return send(404, { message: `no ${path}` });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const remove = new RemoveService({
      prisma,
      radarr: new RadarrClient({ url: `${base}/radarr`, apiKey: KEY }),
      sonarr: new SonarrClient({ url: `${base}/sonarr`, apiKey: KEY }),
      scanQueue: { request: (libraryIds?: string[]) => void scans.push(libraryIds ?? []) },
    });
    app = await buildApp({
      checkDatabase: async () => {},
      services: {
        prisma,
        scanner: {},
        metadata: {},
        images: {},
        mediaRoot: '/media',
        remove,
      } as unknown as AppServices,
      auth: TEST_AUTH,
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Beheer', username: 'beheer', password: 'een-lang-wachtwoord' },
    });
    admin = { cookie: String(setup.headers['set-cookie']).split(';')[0] ?? '' };
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
    member = { cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' };

    const movies = await prisma.library.create({
      data: { name: 'Movies', type: 'MOVIES', path: 'Movies' },
    });
    const series = await prisma.library.create({
      data: { name: 'Series', type: 'SHOWS', path: 'Series' },
    });
    ids.movies = movies.id;
    const file = (path: string, size: number) => ({
      path,
      size: BigInt(size),
      modifiedAt: new Date(),
    });
    const movie = await prisma.mediaItem.create({
      data: {
        libraryId: movies.id,
        type: 'MOVIE',
        path: 'Movies/Dune (2021)',
        title: 'Dune',
        sortTitle: 'dune',
        year: 2021,
        tmdbId: 438631,
        files: { create: [file('Movies/Dune (2021)/Dune (2021) Bluray-2160p.mkv', 60e9)] },
      },
    });
    ids.movie = movie.id;
    await prisma.mediaRequest.create({
      data: { kind: 'MOVIE', tmdbId: 438631, title: 'Dune', status: 'AVAILABLE' },
    });
    const show = await prisma.mediaItem.create({
      data: {
        libraryId: series.id,
        type: 'SHOW',
        path: 'Series/The Office',
        title: 'The Office',
        sortTitle: 'office',
        tvdbId: 73244,
      },
    });
    ids.show = show.id;
    const season = async (number: number, episodes: number[]) =>
      prisma.season.create({
        data: {
          mediaItemId: show.id,
          seasonNumber: number,
          episodes: {
            create: episodes.map((n) => ({
              episodeNumber: n,
              title: n === 2 ? 'Diversity Day' : null,
              files: {
                create: [
                  file(
                    `Series/The Office/Season ${number}/The Office - S0${number}E0${n}.mkv`,
                    1e9,
                  ),
                ],
              },
            })),
          },
        },
        include: { episodes: true },
      });
    const one = await season(1, [1, 2]);
    const two = await season(2, [1]);
    ids.season1 = one.id;
    ids.season2 = two.id;
    ids.episode = one.episodes.find((e) => e.episodeNumber === 2)?.id ?? '';
  });

  beforeEach(() => {
    calls.length = 0;
    scans.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    server?.close();
    await prisma?.$disconnect();
  });

  it('is only for admins', async () => {
    const asked = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.movie}/remove?scope=title`,
      ...as(member),
    });
    expect(asked.statusCode).toBe(403);
    const done = await app.inject({
      method: 'POST',
      url: `/api/items/${ids.movie}/remove`,
      ...as(member),
      payload: { scope: 'title' },
    });
    expect(done.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('shows what removing a film would do, then has Radarr delete it', async () => {
    const preview = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.movie}/remove?scope=title`,
      ...as(admin),
    });
    expect(preview.json<RemovePreview>()).toMatchObject({
      scope: 'title',
      service: 'radarr',
      label: 'Dune (2021)',
      files: 1,
      sizeBytes: 60e9,
      unknownFiles: 0,
    });
    expect(calls).toEqual([]);

    const done = await app.inject({
      method: 'POST',
      url: `/api/items/${ids.movie}/remove`,
      ...as(admin),
      payload: { scope: 'title' },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json<RemoveResult>()).toEqual({ removedFiles: 1, scanning: true });
    expect(calls).toEqual(['radarr DELETE /movie/12?deleteFiles=true&addImportExclusion=false']);
    expect(scans).toEqual([[ids.movies]]);
    // It can be asked for again.
    expect(await prisma.mediaRequest.count({ where: { tmdbId: 438631 } })).toBe(0);
    // CineVault itself removes nothing: the scan does, once the files are gone.
    expect(await prisma.mediaItem.count({ where: { id: ids.movie } })).toBe(1);
  });

  it('removes one episode: the file through Sonarr, and Sonarr stops looking for it', async () => {
    const preview = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.show}/remove?scope=episode&episodeId=${ids.episode}`,
      ...as(admin),
    });
    expect(preview.json<RemovePreview>()).toMatchObject({
      service: 'sonarr',
      label: 'The Office: S1 · A2 · Diversity Day',
      files: 1,
      unknownFiles: 0,
    });
    const done = await app.inject({
      method: 'POST',
      url: `/api/items/${ids.show}/remove`,
      ...as(admin),
      payload: { scope: 'episode', episodeId: ids.episode },
    });
    expect(done.json<RemoveResult>().removedFiles).toBe(1);
    expect(calls).toEqual([
      'sonarr PUT /episode/monitor {"episodeIds":[402],"monitored":false}',
      'sonarr DELETE /episodefile/302',
    ]);
  });

  it('removes a season', async () => {
    const done = await app.inject({
      method: 'POST',
      url: `/api/items/${ids.show}/remove`,
      ...as(admin),
      payload: { scope: 'season', seasonId: ids.season1 },
    });
    expect(done.json<RemoveResult>().removedFiles).toBe(2);
    expect(calls).toEqual([
      'sonarr PUT /episode/monitor {"episodeIds":[401,402],"monitored":false}',
      'sonarr DELETE /episodefile/301',
      'sonarr DELETE /episodefile/302',
    ]);
  });

  it('removes a whole show through Sonarr', async () => {
    const preview = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.show}/remove?scope=title`,
      ...as(admin),
    });
    expect(preview.json<RemovePreview>()).toMatchObject({ label: 'The Office', files: 3 });
    await app.inject({
      method: 'POST',
      url: `/api/items/${ids.show}/remove`,
      ...as(admin),
      payload: { scope: 'title' },
    });
    expect(calls).toEqual([
      'sonarr DELETE /series/21?deleteFiles=true&addImportListExclusion=false',
    ]);
  });

  it('says so when Radarr does not know the title, or the target is wrong', async () => {
    // A wrong match in CineVault: Radarr has that id, but for another folder.
    await prisma.mediaItem.update({
      where: { id: ids.movie },
      data: { path: 'Movies/Something Else (2010)' },
    });
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.movie}/remove?scope=title`,
      ...as(admin),
    });
    expect(wrong.statusCode).toBe(409);

    await prisma.mediaItem.update({
      where: { id: ids.movie },
      data: { tmdbId: 77, path: 'Movies/Unknown (1999)' },
    });
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.movie}/remove?scope=title`,
      ...as(admin),
    });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json<{ error: string }>().error).toBe('Radarr kent Dune (2021) niet');

    const season = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.movie}/remove?scope=season&seasonId=${ids.season1}`,
      ...as(admin),
    });
    expect(season.statusCode).toBe(400);
    const otherShow = await app.inject({
      method: 'GET',
      url: `/api/items/${ids.show}/remove?scope=season&seasonId=${crypto.randomUUID()}`,
      ...as(admin),
    });
    expect(otherShow.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});
