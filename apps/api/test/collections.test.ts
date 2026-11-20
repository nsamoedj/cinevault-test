// Collecties: TMDB's collection of a film and the collection itself (a fake
// fetch), and the collections, their parts, "Volgende in de reeks" and a kids
// profile against PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import type { CollectionDetails, CollectionSummary, HomeDto, ItemDetails } from '@cinevault/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { CollectionService } from '../src/collections.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { TmdbProvider } from '../src/metadata/tmdb.js';
import type { CollectionMetadata } from '../src/metadata/types.js';
import { TEST_AUTH } from './auth-helpers.js';
import { fakeFetch, noSleep } from './metadata-helpers.js';

const english = (url: URL) => url.searchParams.get('language') === 'en-US';

describe('TMDB collections', () => {
  it("knows a film's collection, in English, and a collection's parts in order", async () => {
    const { fetch } = fakeFetch([
      {
        match: (url) => url.pathname === '/3/movie/671' && english(url),
        body: {
          id: 671,
          title: "Harry Potter and the Philosopher's Stone",
          belongs_to_collection: { id: 1241, name: 'Harry Potter Collection' },
        },
      },
      {
        match: (url) => url.pathname === '/3/movie/671',
        body: {
          id: 671,
          title: 'Harry Potter en de Steen der Wijzen',
          overview: 'Een jongen ontdekt dat hij een tovenaar is.',
          belongs_to_collection: { id: 1241, name: 'Harry Potter Filmreeks' },
        },
      },
      {
        match: (url) => url.pathname === '/3/collection/1241' && english(url),
        body: {
          id: 1241,
          name: 'Harry Potter Collection',
          overview: 'The boy who lived.',
          poster_path: '/c.jpg',
          parts: [
            { id: 672, title: 'Chamber of Secrets', release_date: '2002-11-13' },
            { id: 999, title: 'Announced', release_date: '' },
            { id: 671, title: "Philosopher's Stone", release_date: '2001-11-16' },
          ],
        },
      },
      {
        match: (url) => url.pathname === '/3/collection/1241',
        body: { id: 1241, name: 'Harry Potter Filmreeks', overview: 'De jongen die bleef leven.' },
      },
    ]);
    const tmdb = new TmdbProvider({ apiKey: 'v3key', fetch, sleep: noSleep, language: 'nl-NL' });
    const movie = await tmdb.getMovie(671);
    expect(movie?.collection).toEqual({ id: 1241, name: 'Harry Potter Collection' });
    const collection = await tmdb.collection(1241);
    expect(collection).toMatchObject({
      id: 1241,
      name: 'Harry Potter Collection',
      overview: 'De jongen die bleef leven.',
      posterRef: 'tmdb:w342/c.jpg',
    });
    expect(collection?.parts.map((p) => p.tmdbId)).toEqual([671, 672, 999]);
    expect(collection?.parts[0]).toMatchObject({ year: 2001, releaseDate: '2001-11-16' });
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('collections (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let collections: CollectionService;
  const files: Record<string, string> = {};
  const items: Record<string, string> = {};
  const admin = { id: '', cookie: '' };
  const kid = { cookie: '' };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });
  const tmdbCollection: CollectionMetadata = {
    id: 10,
    name: 'Space Saga Collection',
    overview: 'Een reeks in de ruimte.',
    backdropRef: 'tmdb:w1280/b.jpg',
    parts: [
      { tmdbId: 101, title: 'Space Saga', releaseDate: '2001-05-01', year: 2001 },
      { tmdbId: 102, title: 'Space Saga II', releaseDate: '2003-05-01', year: 2003 },
      { tmdbId: 103, title: 'Space Saga III', releaseDate: '2005-05-01', year: 2005 },
      { tmdbId: 104, title: 'Space Saga IV', releaseDate: '2007-05-01', year: 2007 },
      { tmdbId: 105, title: 'Space Saga V' },
    ],
  };

  const film = async (
    key: string,
    tmdbId: number,
    year: number,
    ageRating: number,
    collection = 10,
  ) => {
    const library = await prisma.library.findFirstOrThrow();
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'MOVIE',
        path: `Movies/${key}`,
        title: key,
        sortTitle: key.toLowerCase(),
        year,
        releaseDate: new Date(`${year}-05-01T00:00:00Z`),
        tmdbId,
        ageRating,
        metadataStatus: 'MATCHED',
        collectionTmdbId: collection,
        collectionName: 'Space Saga Collection',
        files: {
          create: {
            path: `Movies/${key}/${key}.mkv`,
            size: 1n,
            modifiedAt: new Date(),
            durationMs: 6_000_000,
          },
        },
      },
      include: { files: true },
    });
    items[key] = item.id;
    files[key] = item.files[0]?.id ?? '';
  };

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "MediaFile", "WatchProgress", "User", "Session", "Collection", "MediaRequest" CASCADE',
    );
    await prisma.library.create({ data: { name: 'Movies', type: 'MOVIES', path: 'Movies' } });
    await film('Space Saga', 101, 2001, 6);
    await film('Space Saga II', 102, 2003, 12);
    await film('Space Saga IV', 104, 2007, 6);
    // A collection with one film here: not shown as a collection.
    await film('Lonely', 201, 2010, 6, 20);
    await prisma.mediaRequest.create({
      data: { kind: 'MOVIE', tmdbId: 103, title: 'Space Saga III', status: 'PENDING' },
    });
    const asked: number[] = [];
    collections = new CollectionService({
      prisma,
      tmdb: {
        collection: async (id) => {
          asked.push(id);
          return id === 10 ? tmdbCollection : undefined;
        },
      },
    });
    expect(await collections.refresh()).toBe(1);
    // A week fresh: not asked again.
    expect(await collections.refresh()).toBe(0);
    expect(asked).toEqual([10, 20, 20]);

    const services = { prisma, scanner: {}, metadata: {}, images: {}, mediaRoot: '/media' };
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
    admin.id = setup.json<{ user: { id: string } }>().user.id;
    admin.cookie = String(setup.headers['set-cookie']).split(';')[0] ?? '';
    await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(admin),
      payload: {
        displayName: 'Kind',
        username: 'kind',
        password: 'nog-een-wachtwoord',
        role: 'USER',
        maxAge: 9,
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'kind', password: 'nog-een-wachtwoord' },
    });
    kid.cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('lists the collections with two films or more here', async () => {
    const list = (await app.inject({ url: '/api/collections', ...as(admin) })).json<
      CollectionSummary[]
    >();
    expect(list).toEqual([
      {
        id: 10,
        name: 'Space Saga Collection',
        backdropUrl: '/api/images/tmdb/w1280/b.jpg',
        owned: 3,
        total: 5,
        watched: 0,
      },
    ]);
    expect((await app.inject({ url: '/api/collections/20', ...as(admin) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/collections/99', ...as(admin) })).statusCode).toBe(404);
  });

  it('shows all parts in order: here, asked for, announced; and the next one to watch', async () => {
    let details = (
      await app.inject({ url: '/api/collections/10', ...as(admin) })
    ).json<CollectionDetails>();
    expect(
      details.parts.map((p) => [p.title, Boolean(p.item), p.requested ?? false, p.released]),
    ).toEqual([
      ['Space Saga', true, false, true],
      ['Space Saga II', true, false, true],
      ['Space Saga III', false, true, true],
      ['Space Saga IV', true, false, true],
      ['Space Saga V', false, false, false],
    ]);
    expect(details.next?.title).toBe('Space Saga');

    // The first one watched: the second is next, also on the start page.
    await prisma.watchProgress.create({
      data: {
        userId: admin.id,
        mediaFileId: files['Space Saga'] ?? '',
        positionMs: 6_000_000,
        completed: true,
      },
    });
    details = (
      await app.inject({ url: '/api/collections/10', ...as(admin) })
    ).json<CollectionDetails>();
    expect(details).toMatchObject({ watched: 1, next: { title: 'Space Saga II' } });
    const home = (await app.inject({ url: '/api/home', ...as(admin) })).json<HomeDto>();
    const nextRow = home.rows.find((r) => r.id === 'collection-next');
    expect(nextRow?.items.map((i) => i.title)).toEqual(['Space Saga II']);
    const row = home.rows.find((r) => r.id === 'collections');
    expect(row?.collections?.map((c) => c.name)).toEqual(['Space Saga Collection']);
    expect(row?.items.map((i) => i.title)).toEqual(['Space Saga II']);
  });

  it("tells a film's page which collection it is in", async () => {
    const details = (
      await app.inject({ url: `/api/items/${items['Space Saga IV']}`, ...as(admin) })
    ).json<ItemDetails>();
    expect(details.collection).toEqual({
      id: 10,
      name: 'Space Saga Collection',
      owned: 3,
      total: 5,
    });
  });

  it('shows a kids profile only the films for its age', async () => {
    const list = (await app.inject({ url: '/api/collections', ...as(kid) })).json<
      CollectionSummary[]
    >();
    expect(list).toMatchObject([{ id: 10, owned: 2, total: 2 }]);
    const details = (
      await app.inject({ url: '/api/collections/10', ...as(kid) })
    ).json<CollectionDetails>();
    expect(details.parts.map((p) => p.title)).toEqual(['Space Saga', 'Space Saga IV']);
  });
});
