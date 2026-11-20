// Watch progress per profile, against a real PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { reachedEnd } from '../src/progress.js';
import { TEST_AUTH } from './auth-helpers.js';

describe('reachedEnd', () => {
  it('counts the last 8% or the credits as watched', () => {
    const hour = 3_600_000;
    expect(reachedEnd(0.93 * hour, hour)).toBe(true);
    expect(reachedEnd(hour - 90_000, hour)).toBe(true);
    expect(reachedEnd(0.5 * hour, hour)).toBe(false);
    // A short clip: two minutes from the end is still the middle.
    expect(reachedEnd(30_000, 150_000)).toBe(false);
    expect(reachedEnd(10_000, undefined)).toBe(false);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('watch progress (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let anna = '';
  let bram = '';
  const ids = {
    library: '',
    movie: '',
    movieFile: '',
    show: '',
    season: '',
    episodes: [] as string[],
    files: [] as string[],
  };

  const as = (cookie: string) => ({ headers: { cookie } });

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "Subtitle", "WatchProgress", "User", "Session" CASCADE',
    );
    const services = { prisma, scanner: {}, metadata: {}, images: {}, mediaRoot: '/media' };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: TEST_AUTH,
    });

    const library = await prisma.library.create({
      data: { name: 'Mixed', type: 'SHOWS', path: 'Mixed' },
    });
    ids.library = library.id;
    const file = (path: string) => ({
      path,
      size: 1n,
      modifiedAt: new Date(),
      durationMs: 3_600_000,
    });
    const movie = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'MOVIE',
        path: 'Mixed/Film',
        title: 'Film',
        sortTitle: 'film',
        files: { create: file('Mixed/Film/Film.mkv') },
      },
      include: { files: true },
    });
    ids.movie = movie.id;
    ids.movieFile = movie.files[0]?.id ?? '';
    const show = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'SHOW',
        path: 'Mixed/Show',
        title: 'Show',
        sortTitle: 'show',
      },
    });
    ids.show = show.id;
    const season = await prisma.season.create({ data: { mediaItemId: show.id, seasonNumber: 1 } });
    ids.season = season.id;
    for (const n of [1, 2, 3]) {
      const episode = await prisma.episode.create({
        data: {
          seasonId: season.id,
          episodeNumber: n,
          title: `Episode ${n}`,
          files: { create: file(`Mixed/Show/S01E0${n}.mkv`) },
        },
        include: { files: true },
      });
      ids.episodes.push(episode.id);
      ids.files.push(episode.files[0]?.id ?? '');
    }

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Anna', username: 'anna', password: 'anna-heeft-een-wachtwoord' },
    });
    anna = String(setup.headers['set-cookie']).split(';')[0] ?? '';
    await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(anna),
      payload: { displayName: 'Bram', username: 'bram', password: 'bram-heeft-een-wachtwoord' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'bram', password: 'bram-heeft-een-wachtwoord' },
    });
    bram = String(login.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const report = (cookie: string, fileId: string, positionMs: number) =>
    app.inject({
      method: 'PUT',
      url: `/api/progress/${fileId}`,
      ...as(cookie),
      payload: { positionMs },
    });

  it('remembers where a movie stopped, per profile', async () => {
    const saved = await report(anna, ids.movieFile, 1_800_000);
    expect(saved.json()).toMatchObject({
      fileId: ids.movieFile,
      positionMs: 1_800_000,
      durationMs: 3_600_000,
      watched: false,
    });

    const items = (
      await app.inject({ url: `/api/libraries/${ids.library}/items`, ...as(anna) })
    ).json().items;
    expect(items.find((i: { id: string }) => i.id === ids.movie).progress).toEqual({
      watched: false,
      fraction: 0.5,
    });
    const details = (await app.inject({ url: `/api/items/${ids.movie}`, ...as(anna) })).json();
    expect(details.resume).toMatchObject({ positionMs: 1_800_000 });

    const continued = (await app.inject({ url: '/api/continue', ...as(anna) })).json();
    expect(continued).toEqual([
      expect.objectContaining({
        kind: 'resume',
        fileId: ids.movieFile,
        positionMs: 1_800_000,
        item: expect.objectContaining({ title: 'Film' }),
      }),
    ]);

    // Bram has his own progress.
    expect((await app.inject({ url: '/api/continue', ...as(bram) })).json()).toEqual([]);
    const bramItems = (
      await app.inject({ url: `/api/libraries/${ids.library}/items`, ...as(bram) })
    ).json().items;
    expect(bramItems.find((i: { id: string }) => i.id === ids.movie).progress).toBeUndefined();
  });

  it('marks a movie watched near the end and keeps it watched on a rewatch', async () => {
    // From halfway (1_800_000) straight to the end is a jump, not watching.
    expect((await report(anna, ids.movieFile, 3_600_000)).json().watched).toBe(false);
    expect((await report(anna, ids.movieFile, 3_000_000)).json().watched).toBe(false);
    expect((await report(anna, ids.movieFile, 3_500_000)).json().watched).toBe(true);
    expect((await app.inject({ url: '/api/continue', ...as(anna) })).json()).toEqual([]);
    // Watching again from the start: still watched, and resumable halfway.
    expect((await report(anna, ids.movieFile, 1_000_000)).json().watched).toBe(true);
    expect((await app.inject({ url: '/api/continue', ...as(anna) })).json()[0]).toMatchObject({
      kind: 'resume',
      positionMs: 1_000_000,
    });
  });

  it('offers the next episode after finishing one', async () => {
    await report(bram, ids.files[0] ?? '', 3_000_000);
    await report(bram, ids.files[0] ?? '', 3_550_000);
    const continued = (await app.inject({ url: '/api/continue', ...as(bram) })).json();
    expect(continued).toEqual([
      expect.objectContaining({
        kind: 'next',
        fileId: ids.files[1],
        positionMs: 0,
        episode: expect.objectContaining({ seasonNumber: 1, episodeNumber: 2, title: 'Episode 2' }),
      }),
    ]);
    // Halfway through episode 2: resume that one.
    await report(bram, ids.files[1] ?? '', 600_000);
    expect((await app.inject({ url: '/api/continue', ...as(bram) })).json()[0]).toMatchObject({
      kind: 'resume',
      fileId: ids.files[1],
    });

    const show = (await app.inject({ url: `/api/items/${ids.show}`, ...as(bram) })).json();
    const episodes = show.seasons[0].episodes;
    expect(
      episodes.map((e: { progress?: { watched: boolean } }) => e.progress?.watched ?? null),
    ).toEqual([true, false, null]);
    expect(show.progress).toEqual({ watched: false, watchedEpisodes: 1, totalEpisodes: 3 });
  });

  it('tells the player where it stopped and what comes next', async () => {
    const context = (await app.inject({ url: `/api/files/${ids.files[1]}`, ...as(bram) })).json();
    expect(context.progress).toMatchObject({ positionMs: 600_000, watched: false });
    expect(context.episode).toMatchObject({ id: ids.episodes[1], episodeNumber: 2 });
    expect(context.next).toEqual({
      fileId: ids.files[2],
      seasonNumber: 1,
      episodeNumber: 3,
      title: 'Episode 3',
    });
    const last = (await app.inject({ url: `/api/files/${ids.files[2]}`, ...as(bram) })).json();
    expect(last.next).toBeUndefined();
    expect(last.progress).toBeUndefined();
  });

  it('marks episodes, seasons and shows watched or not', async () => {
    const put = (url: string, watched: boolean) =>
      app.inject({ method: 'PUT', url, ...as(bram), payload: { watched } });
    expect((await put(`/api/episodes/${ids.episodes[1]}/watched`, true)).statusCode).toBe(204);
    // Episode 3 is next now.
    expect((await app.inject({ url: '/api/continue', ...as(bram) })).json()[0]).toMatchObject({
      kind: 'next',
      fileId: ids.files[2],
    });

    expect((await put(`/api/seasons/${ids.season}/watched`, true)).statusCode).toBe(204);
    let items = (
      await app.inject({ url: `/api/libraries/${ids.library}/items`, ...as(bram) })
    ).json().items;
    expect(items.find((i: { id: string }) => i.id === ids.show).progress).toEqual({
      watched: true,
      watchedEpisodes: 3,
      totalEpisodes: 3,
    });
    // All caught up: nothing to continue.
    expect((await app.inject({ url: '/api/continue', ...as(bram) })).json()).toEqual([]);

    expect((await put(`/api/items/${ids.show}/watched`, false)).statusCode).toBe(204);
    items = (await app.inject({ url: `/api/libraries/${ids.library}/items`, ...as(bram) })).json()
      .items;
    expect(items.find((i: { id: string }) => i.id === ids.show).progress).toBeUndefined();
    expect((await put(`/api/items/${ids.movie}/watched`, true)).statusCode).toBe(204);
    expect(
      (await put('/api/items/00000000-0000-4000-8000-000000000000/watched', true)).statusCode,
    ).toBe(404);
  });

  it('needs a person: scripts have no progress', async () => {
    const script = { headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` } };
    expect((await app.inject({ url: '/api/continue', ...script })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/continue' })).statusCode).toBe(401);
    // Lists still work for scripts, without progress.
    const items = (
      await app.inject({ url: `/api/libraries/${ids.library}/items`, ...script })
    ).json().items;
    expect(items.every((i: { progress?: unknown }) => i.progress === undefined)).toBe(true);
  });
  it('remembers the audio and subtitles chosen for a show, per profile', async () => {
    const context = async (cookie: string) =>
      (await app.inject({ url: `/api/files/${ids.files[1]}`, ...as(cookie) })).json();
    expect((await context(anna)).tracks).toBeUndefined();

    const put = (cookie: string, payload: object) =>
      app.inject({ method: 'PUT', url: `/api/items/${ids.show}/tracks`, ...as(cookie), payload });
    expect((await put(anna, { audioLanguage: 'ja' })).statusCode).toBe(200);
    expect((await put(anna, { subtitle: 'Dutch' })).statusCode).toBe(200);
    // Another episode of the show, on another device: the same choice.
    expect((await context(anna)).tracks).toEqual({
      audioLanguage: 'jpn',
      subtitle: 'nld',
      source: 'saved',
    });
    expect((await context(bram)).tracks).toBeUndefined();

    expect((await put(anna, { subtitle: 'off', audioLanguage: null })).statusCode).toBe(200);
    expect((await context(anna)).tracks).toEqual({ subtitle: 'off', source: 'saved' });
    expect((await put(anna, { subtitle: 'klingon' })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/items/00000000-0000-4000-8000-000000000000/tracks',
          ...as(anna),
          payload: { subtitle: 'off' },
        })
      ).statusCode,
    ).toBe(404);

    // Anime: Japanese until something else is chosen.
    await prisma.library.update({ where: { id: ids.library }, data: { type: 'ANIME' } });
    try {
      expect((await context(bram)).tracks).toEqual({ audioLanguage: 'jpn', source: 'anime' });
      expect((await context(anna)).tracks).toEqual({ subtitle: 'off', source: 'saved' });
    } finally {
      await prisma.library.update({ where: { id: ids.library }, data: { type: 'SHOWS' } });
    }
  });
});
