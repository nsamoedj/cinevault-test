// Start page, search, sorting and genres, against a real PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('start page and search (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let cookie = '';
  let movies = '';
  let shows = '';
  const ids: Record<string, string> = {};
  const as = () => ({ headers: { cookie } });

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
    movies = (
      await prisma.library.create({ data: { name: 'Movies', type: 'MOVIES', path: 'Movies' } })
    ).id;
    shows = (
      await prisma.library.create({ data: { name: 'Series', type: 'SHOWS', path: 'Series' } })
    ).id;

    const day = (n: number) => new Date(Date.UTC(2026, 9, n));
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    const movie = async (
      title: string,
      extra: {
        year?: number;
        rating?: number;
        genres?: string[];
        added: number;
        backdrop?: boolean;
        released?: Date;
        tmdb?: number;
        recommended?: number[];
      },
    ) => {
      const item = await prisma.mediaItem.create({
        data: {
          libraryId: movies,
          type: 'MOVIE',
          path: `Movies/${title}`,
          title,
          sortTitle: title.toLowerCase().replace(/^the /, ''),
          year: extra.year ?? null,
          rating: extra.rating ?? null,
          genres: extra.genres ?? [],
          // CineVault saw them all at once; the files say what came when.
          createdAt: day(1),
          addedAt: day(extra.added),
          ...(extra.released && { releaseDate: extra.released }),
          ...(extra.tmdb && { tmdbId: extra.tmdb }),
          ...(extra.recommended && { recommendedTmdbIds: extra.recommended }),
          metadataStatus: 'MATCHED',
          overview: `Over ${title}.`,
          ...(extra.backdrop && { backdropPath: `tmdb:w1280/${title.length}.jpg` }),
          files: {
            create: {
              path: `Movies/${title}/${title}.mkv`,
              size: 1n,
              modifiedAt: day(extra.added),
              addedAt: day(extra.added),
              durationMs: 7_200_000,
              height: 2160,
              hdrFormat: 'HDR10',
            },
          },
        },
      });
      ids[title] = item.id;
    };
    await movie('Up', {
      tmdb: 14160,
      year: 2009,
      rating: 8.0,
      genres: ['Animatie', 'Avontuur'],
      added: 3,
      backdrop: true,
    });
    await movie('Pixar Shorts: Up', { year: 2010, rating: 6.5, genres: ['Animatie'], added: 1 });
    await movie('The Abyss', {
      year: 1989,
      rating: 7.6,
      genres: ['Avontuur', 'Sciencefiction'],
      added: 2,
    });
    await movie('Coco', {
      year: 2017,
      rating: 8.2,
      genres: ['Animatie', 'Familie'],
      added: 4,
      backdrop: true,
      released: daysAgo(40),
      // TMDB recommends Up (in the library) and a film that is not here.
      recommended: [999, 14160],
    });
    await movie('Zathura', { year: 2005, genres: ['Avontuur', 'Familie'], added: 5 });

    const show = await prisma.mediaItem.create({
      data: {
        libraryId: shows,
        type: 'SHOW',
        path: 'Series/Bluey',
        title: 'Bluey',
        sortTitle: 'bluey',
        genres: ['Animatie'],
        rating: 9,
        metadataStatus: 'MATCHED',
        overview: 'Een hond.',
        backdropPath: 'tmdb:w1280/bluey.jpg',
        logoPath: 'tmdb:w500/bluey-logo.png',
        trailerKey: 'abc123',
        createdAt: day(1),
        addedAt: day(6),
        nextEpisodeSeason: 2,
        nextEpisodeNumber: 1,
        nextEpisodeTitle: 'Nieuw seizoen',
        nextEpisodeAirDate: new Date(
          `${new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
        ),
      },
    });
    ids.Bluey = show.id;
    const season = await prisma.season.create({ data: { mediaItemId: show.id, seasonNumber: 1 } });
    for (const n of [1, 2]) {
      const episode = await prisma.episode.create({
        data: {
          seasonId: season.id,
          episodeNumber: n,
          title: `Aflevering ${n}`,
          airDate: daysAgo(12 - n),
          files: {
            create: {
              path: `Series/Bluey/S01E0${n}.mkv`,
              size: 1n,
              modifiedAt: day(6),
              addedAt: new Date(day(6).getTime() - n * 3_600_000),
              durationMs: 420_000,
            },
          },
        },
        include: { files: true },
      });
      ids[`Bluey ${n}`] = episode.files[0]?.id ?? '';
    }

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Anna', username: 'anna', password: 'anna-heeft-een-wachtwoord' },
    });
    cookie = String(setup.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const titles = (items: { title: string }[]) => items.map((i) => i.title);

  it('sorts and filters a library', async () => {
    const list = async (q: string) =>
      titles(
        (await app.inject({ url: `/api/libraries/${movies}/items?${q}`, ...as() })).json().items,
      );
    expect(await list('')).toEqual(['The Abyss', 'Coco', 'Pixar Shorts: Up', 'Up', 'Zathura']);
    expect(await list('sort=added')).toEqual([
      'Zathura',
      'Coco',
      'Up',
      'The Abyss',
      'Pixar Shorts: Up',
    ]);
    expect(await list('sort=year')).toEqual([
      'Coco',
      'Pixar Shorts: Up',
      'Up',
      'Zathura',
      'The Abyss',
    ]);
    // Titles without a rating last.
    expect(await list('sort=rating')).toEqual([
      'Coco',
      'Up',
      'The Abyss',
      'Pixar Shorts: Up',
      'Zathura',
    ]);
    expect(await list('genre=Familie')).toEqual(['Coco', 'Zathura']);

    const genres = (await app.inject({ url: `/api/libraries/${movies}/genres`, ...as() })).json();
    expect(genres).toEqual(['Animatie', 'Avontuur', 'Familie', 'Sciencefiction']);
  });

  it('searches all libraries, titles that start with the search first', async () => {
    const found = (await app.inject({ url: '/api/search?q=up', ...as() })).json();
    expect(titles(found)).toEqual(['Up', 'Pixar Shorts: Up']);
    expect(titles((await app.inject({ url: '/api/search?q=blu', ...as() })).json())).toEqual([
      'Bluey',
    ]);
    expect((await app.inject({ url: '/api/search?q=', ...as() })).statusCode).toBe(400);
  });

  it('builds the start page: billboard and rows', async () => {
    // Anna stopped halfway through Up.
    await app.inject({
      method: 'PUT',
      url: `/api/progress/${(await prisma.mediaFile.findFirstOrThrow({ where: { mediaItemId: ids.Up } })).id}`,
      ...as(),
      payload: { positionMs: 1_800_000 },
    });

    const home = (await app.inject({ url: '/api/home', ...as() })).json();
    // Only titles with a backdrop and a description.
    expect(titles(home.featured).sort()).toEqual(['Bluey', 'Coco', 'Up']);
    const up = home.featured.find((f: { title: string }) => f.title === 'Up');
    expect(up).toMatchObject({
      backdropUrl: '/api/images/tmdb/w1280/2.jpg',
      overview: 'Over Up.',
      height: 2160,
      hdrFormat: 'HDR10',
      play: { positionMs: 1_800_000, durationMs: 7_200_000 },
      progress: { watched: false, fraction: 0.25 },
    });
    // A show starts at its first episode.
    const bluey = home.featured.find((f: { title: string }) => f.title === 'Bluey');
    expect(bluey.play).toEqual({ fileId: ids['Bluey 1'], seasonNumber: 1, episodeNumber: 1 });

    const rows = home.rows.map((r: { title: string; items: { title: string }[] }) => [
      r.title,
      titles(r.items),
    ]);
    // A show with new episodes: from the first of the batch.
    expect(rows[0]).toEqual(['Nieuwe afleveringen', ['Bluey']]);
    expect(home.rows[0].episodes).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ title: 'Bluey' }),
        fileId: ids['Bluey 1'],
        seasonNumber: 1,
        episodeNumber: 1,
        title: 'Aflevering 1',
        addedAt: new Date(Date.UTC(2026, 9, 6) - 3_600_000).toISOString(),
        count: 2,
      }),
    ]);
    // By when the files came, not when CineVault saw them.
    expect(rows[1]).toEqual([
      'Recent toegevoegde films',
      ['Zathura', 'Coco', 'Up', 'The Abyss', 'Pixar Shorts: Up'],
    ]);
    expect(home.rows[1].libraryId).toBe(movies);
    expect(home.rows[1].sort).toBe('added');
    expect(home.rows[1].items[0].backdropUrl).toBeUndefined();
    // Anna watched half an hour of Up: films like it, the best rated first.
    expect(rows[2]).toEqual([
      'Omdat je Up keek',
      ['Coco', 'The Abyss', 'Pixar Shorts: Up', 'Zathura'],
    ]);
    expect(home.rows[2].because).toEqual({ itemId: ids.Up, title: 'Up' });
    // Released in the last year: Bluey's newest episode aired after Coco came out.
    expect(rows[3]).toEqual(['Nieuwe releases', ['Bluey', 'Coco']]);
    // The next episode of a show here, airing in 3 days.
    expect(rows[4]).toEqual(['Binnenkort', ['Bluey']]);
    expect(home.rows[4].upcoming).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ title: 'Bluey' }),
        seasonNumber: 2,
        episodeNumber: 1,
        title: 'Nieuw seizoen',
        airDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      }),
    ]);
    expect(rows[5]).toEqual(['Hoog gewaardeerd', ['Bluey', 'Coco', 'Up', 'The Abyss']]);
    // Genres with at least three titles, the most common first.
    expect(rows.slice(6).map((r: [string]) => r[0])).toEqual(['Animatie', 'Avontuur']);
    // The billboard shows the logo when there is one.
    expect(bluey.logoUrl).toBe('/api/images/tmdb/w500/bluey-logo.png');
  });

  it('leaves out new episodes the profile has watched, per episode', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'anna' } });
    await prisma.watchProgress.create({
      data: { userId: user.id, mediaFileId: ids['Bluey 1'] ?? '', positionMs: 0, completed: true },
    });
    // Episode 2 started: how far in that episode, not in the whole show.
    await prisma.watchProgress.create({
      data: {
        userId: user.id,
        mediaFileId: ids['Bluey 2'] ?? '',
        positionMs: 105_000,
        durationMs: 420_000,
      },
    });
    const home = (await app.inject({ url: '/api/home', ...as() })).json();
    expect(home.rows[0].episodes[0]).toMatchObject({
      fileId: ids['Bluey 2'],
      count: 1,
      fraction: 0.25,
    });
    // Older apps show the shows as posters: without the show's progress bar.
    expect(home.rows[0].items[0].progress).toBeUndefined();
    await prisma.watchProgress.deleteMany({ where: { mediaFileId: ids['Bluey 2'] ?? '' } });

    await prisma.watchProgress.create({
      data: { userId: user.id, mediaFileId: ids['Bluey 2'] ?? '', positionMs: 0, completed: true },
    });
    const after = (await app.inject({ url: '/api/home', ...as() })).json();
    expect(after.rows[0].id).not.toBe('new-episodes');
  });

  it('leaves out of "Omdat je … keek" what the profile watched, and a row of too few', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'anna' } });
    const coco = await prisma.mediaFile.findFirstOrThrow({ where: { mediaItemId: ids.Coco } });
    await prisma.watchProgress.create({
      data: { userId: user.id, mediaFileId: coco.id, positionMs: 0, completed: true },
    });
    // Like Up, not watched: The Abyss, Pixar Shorts and Zathura; like Coco: two. Too few.
    const home = (await app.inject({ url: '/api/home', ...as() })).json();
    expect(home.rows.filter((r: { id: string }) => r.id.startsWith('because-'))).toEqual([]);
    await prisma.watchProgress.deleteMany({ where: { mediaFileId: coco.id } });
  });

  it('finds titles like this one: recommended first, then shared genres', async () => {
    const similar = (await app.inject({ url: `/api/items/${ids.Coco}/similar`, ...as() })).json();
    expect(titles(similar)[0]).toBe('Up');
    expect(titles(similar)).not.toContain('Coco');
    expect(titles(similar)).not.toContain('Bluey'); // a show, not a film
    // Then by shared genres (Animatie, Familie): Zathura and Pixar Shorts share one each.
    expect(titles(similar).slice(1).sort()).toEqual(['Pixar Shorts: Up', 'Zathura']);
  });

  it('gives the details the logo, the trailer and the next episode', async () => {
    const details = (await app.inject({ url: `/api/items/${ids.Bluey}`, ...as() })).json();
    expect(details).toMatchObject({
      logoUrl: '/api/images/tmdb/w500/bluey-logo.png',
      trailerKey: 'abc123',
      nextEpisode: { seasonNumber: 2, episodeNumber: 1, title: 'Nieuw seizoen' },
    });
  });
});
