// Theme music: Plex's show themes (tvthemes.plexapp.com), from a fake Plex,
// kept in the cache, against PostgreSQL.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { isMp3, NoThemeError, PlexThemeProvider, ThemeService } from '../src/themes/service.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** An MP3 as Plex sends it: big enough to be one. */
const mp3 = (tvdb: number) => Buffer.concat([Buffer.from(`ID3 ${tvdb} `), Buffer.alloc(20_000)]);

describe.skipIf(!databaseUrl)('theme music from Plex (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let themes: ThemeService;
  let cache: string;
  let now = 1_000_000;
  let down = false;
  const asked: string[] = [];
  const ids: Record<string, string> = {};
  const script = { headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` } };
  let kid = '';

  async function title(
    name: string,
    data: { type?: 'SHOW' | 'MOVIE'; tvdbId?: number; tmdbId?: number; ageRating?: number },
  ) {
    const library = await prisma.library.findFirstOrThrow();
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: data.type ?? 'SHOW',
        path: `Series/${name}`,
        title: name,
        sortTitle: name.toLowerCase(),
        metadataStatus: 'MATCHED',
        ageRating: data.ageRating ?? 12,
        ...(data.tvdbId && { tvdbId: data.tvdbId }),
        ...(data.tmdbId && { tmdbId: data.tmdbId }),
      },
    });
    ids[name] = item.id;
  }

  const cached = () => readdirSync(path.join(cache, 'themes')).filter((n) => n.endsWith('.mp3'));

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "User", "Session" CASCADE',
    );
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-themes-'));
    const plex = new PlexThemeProvider(prisma, {
      baseUrl: 'https://plex.test/',
      fetch: (async (input: string) => {
        if (down) throw new TypeError('fetch failed');
        asked.push(input);
        const tvdb = Number(/\/(\d+)\.mp3$/.exec(input)?.[1]);
        if (tvdb === 404) return new Response('Not Found', { status: 404 });
        if (tvdb === 500) return new Response('oops', { status: 500 });
        return new Response(mp3(tvdb), { headers: { 'content-type': 'audio/mpeg' } });
      }) as typeof fetch,
      tvdbId: async (tmdbId) => (tmdbId === 1399 ? 121361 : undefined),
    });
    themes = new ThemeService({ prisma, cacheDir: cache, providers: [plex], now: () => now });

    await prisma.library.create({ data: { name: 'Series', type: 'SHOWS', path: 'Series' } });
    await title('Show', { tvdbId: 81189 });
    await title('Unknown', { tvdbId: 404 });
    await title('Lookup', { tmdbId: 1399 });
    await title('NoIds', {});
    await title('Grown-up', { tvdbId: 73244, ageRating: 16 });
    await title('Later', { tvdbId: 500 });
    await title('Film', { type: 'MOVIE', tmdbId: 603 });

    app = await buildApp({
      checkDatabase: async () => {},
      services: {
        prisma,
        scanner: {},
        metadata: {},
        images: {},
        mediaRoot: '/media',
        themes,
      } as unknown as AppServices,
      auth: TEST_AUTH,
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Ouder', username: 'ouder', password: 'ouder-wachtwoord-1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/users',
      ...script,
      payload: { displayName: 'Kind', username: 'kind', password: 'kind-wachtwoord-1', maxAge: 12 },
    });
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
    rmSync(cache, { recursive: true, force: true });
  });

  it("fetches a show's theme from Plex by its TVDB id, once, and serves it from the cache", async () => {
    const res = await app.inject({ url: `/api/items/${ids.Show}/theme`, ...script });
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info).toMatchObject({ pending: false, off: false, from: { source: 'plex' } });
    expect(info.url).toBe(`/api/items/${ids.Show}/theme.mp3?v=tvdb-81189`);
    expect(asked).toEqual(['https://plex.test/81189.mp3']);

    const audio = await app.inject({ url: info.url, ...script });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(audio.rawPayload.subarray(0, 9).toString()).toBe('ID3 81189');
    const part = await app.inject({
      url: info.url,
      headers: { ...script.headers, range: 'bytes=0-2' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('ID3');

    const again = await app.inject({ url: `/api/items/${ids.Show}/theme`, ...script });
    expect(again.json().url).toBe(info.url);
    expect(asked).toHaveLength(1);
    expect(cached()).toEqual([`${ids.Show}-plex-tvdb-81189.mp3`]);
  });

  it('has none for a film, a show without an id, or one Plex has no theme for', async () => {
    for (const name of ['Film', 'NoIds']) {
      const res = await app.inject({ url: `/api/items/${ids[name]}/theme`, ...script });
      expect(res.json()).toEqual({ url: null, pending: false, off: false });
    }
    const before = asked.length;
    const unknown = await app.inject({ url: `/api/items/${ids.Unknown}/theme`, ...script });
    expect(unknown.json()).toEqual({ url: null, pending: false, off: false });
    expect(asked.slice(before)).toEqual(['https://plex.test/404.mp3']);
    // Not asked again for a week.
    now += 2 * 24 * 60 * 60 * 1000;
    await app.inject({ url: `/api/items/${ids.Unknown}/theme`, ...script });
    expect(asked).toHaveLength(before + 1);
  });

  it('looks up a missing TVDB id from TMDB, and keeps it', async () => {
    const res = await app.inject({ url: `/api/items/${ids.Lookup}/theme`, ...script });
    expect(res.json().url).toBe(`/api/items/${ids.Lookup}/theme.mp3?v=tvdb-121361`);
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id: ids.Lookup } });
    expect(item.tvdbId).toBe(121361);
  });

  it('gives nothing for titles a kids profile may not see', async () => {
    const forKid = await app.inject({
      url: `/api/items/${ids['Grown-up']}/theme`,
      headers: { cookie: kid },
    });
    expect(forKid.statusCode).toBe(404);
    const audio = await app.inject({
      url: `/api/items/${ids['Grown-up']}/theme.mp3`,
      headers: { cookie: kid },
    });
    expect(audio.statusCode).toBe(404);
    const allowed = await app.inject({
      url: `/api/items/${ids.Show}/theme`,
      headers: { cookie: kid },
    });
    expect(allowed.json().url).toBeTruthy();
  });

  it('can be turned off and on by an admin, not by a member', async () => {
    const member = await app.inject({
      method: 'PUT',
      url: `/api/items/${ids.Show}/theme`,
      headers: { cookie: kid },
      payload: { off: true },
    });
    expect(member.statusCode).toBe(403);
    const off = await app.inject({
      method: 'PUT',
      url: `/api/items/${ids.Show}/theme`,
      ...script,
      payload: { off: true },
    });
    expect(off.json()).toEqual({ url: null, pending: false, off: true });
    expect((await themes.ready(ids.Show ?? '')).off).toBe(true);
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/items/${ids.Show}/theme`,
      ...script,
      payload: { fileId: ids.Show },
    });
    expect(bad.statusCode).toBe(400);
    const on = await app.inject({
      method: 'PUT',
      url: `/api/items/${ids.Show}/theme`,
      ...script,
      payload: { off: false },
    });
    expect(on.json().url).toBeTruthy();
  });

  it('waits when Plex is down, and fetches the rest ahead of time', async () => {
    down = true;
    const res = await app.inject({ url: `/api/items/${ids['Grown-up']}/theme`, ...script });
    expect(res.json()).toMatchObject({ url: null, pending: true, from: { source: 'plex' } });
    down = false;
    const before = asked.length;
    // Paused for a while: nothing asked.
    expect(await themes.prepare(20, 0)).toBe(0);
    expect(asked).toHaveLength(before);

    now += 16 * 60 * 1000;
    // Grown-up has one now; Later (500) pauses again.
    expect(await themes.prepare(20, 0)).toBe(1);
    expect(asked.slice(before).sort()).toEqual([
      'https://plex.test/500.mp3',
      'https://plex.test/73244.mp3',
    ]);
    const ready = await themes.ready(ids['Grown-up'] ?? '');
    expect(ready.url).toBeTruthy();
    // Only what is there already: no request.
    expect((await themes.ready(ids.Later ?? '')).url).toBeNull();
  });

  it('clears the themes cut from the own files before', async () => {
    const dir = path.join(cache, 'themes');
    const old = `${ids.Show}-intro-0123456789abcdef.mp3`;
    writeFileSync(path.join(dir, old), 'old');
    writeFileSync(path.join(dir, `${ids.Film}-end-credits-0123456789abcdef.mp3`), 'old');
    mkdirSync(path.join(dir, 'end-credits'), { recursive: true });
    writeFileSync(path.join(dir, 'end-credits', 'x.json'), '{}');
    await themes.cleanUp();
    expect(readdirSync(dir).sort()).toEqual(
      [
        `${ids.Show}-plex-tvdb-81189.mp3`,
        `${ids['Grown-up']}-plex-tvdb-73244.mp3`,
        `${ids.Lookup}-plex-tvdb-121361.mp3`,
      ].sort(),
    );
  });

  it('tells Beheer how far it is', async () => {
    const res = await app.inject({ url: '/api/themes/status', ...script });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      shows: 6,
      ready: 3,
      none: 1,
      failed: 0,
      // Which show, and what Plex answered: to check it by hand.
      missing: [
        {
          itemId: ids.Unknown,
          title: 'Unknown',
          tvdbId: 404,
          none: true,
          reason: 'Plex: 404 https',
        },
      ],
    });
    const member = await app.inject({ url: '/api/themes/status', headers: { cookie: kid } });
    expect(member.statusCode).toBe(403);
  });

  it('asks Plex again at once for what it had none for (Beheer)', async () => {
    const member = await app.inject({
      method: 'POST',
      url: '/api/themes/retry',
      headers: { cookie: kid },
      payload: {},
    });
    expect(member.statusCode).toBe(403);
    const before = asked.length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/themes/retry',
      ...script,
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    await expect
      .poll(() => asked.slice(before).sort())
      .toEqual(['https://plex.test/404.mp3', 'https://plex.test/500.mp3']);
    await expect
      .poll(async () => (await app.inject({ url: '/api/themes/status', ...script })).json().none)
      .toBe(1);
  });
});

describe('Plex theme service', () => {
  it('asks over HTTP when HTTPS cannot connect, and keeps using what answered', async () => {
    const asked: string[] = [];
    const item = { type: 'SHOW', tvdbId: 81189, tmdbId: null };
    const prisma = { mediaItem: { findUnique: async () => item } } as unknown as PrismaClient;
    const plex = new PlexThemeProvider(prisma, {
      fetch: (async (url: string) => {
        asked.push(url);
        if (url.startsWith('https:')) throw new TypeError('fetch failed');
        return new Response(mp3(81189), { headers: { 'content-type': 'binary/octet-stream' } });
      }) as typeof fetch,
    });
    const [source] = await plex.sources('x');
    if (!source) throw new Error('no source');
    expect((await plex.audio(source)).subarray(0, 3).toString()).toBe('ID3');
    expect(asked).toEqual([
      'https://tvthemes.plexapp.com/81189.mp3',
      'http://tvthemes.plexapp.com/81189.mp3',
    ]);
    await plex.audio(source);
    expect(asked.at(-1)).toBe('http://tvthemes.plexapp.com/81189.mp3');
    expect(asked).toHaveLength(3);
  });

  it('asks over HTTP when HTTPS has none, before deciding Plex has none', async () => {
    const asked: string[] = [];
    const item = { type: 'SHOW', tvdbId: 81189, tmdbId: null };
    const prisma = { mediaItem: { findUnique: async () => item } } as unknown as PrismaClient;
    let http = 200;
    const plex = new PlexThemeProvider(prisma, {
      fetch: (async (url: string) => {
        asked.push(url);
        if (url.startsWith('https:')) return new Response('Not Found', { status: 404 });
        if (http !== 200) return new Response('Forbidden', { status: http });
        return new Response(mp3(81189), { headers: { 'content-type': 'audio/mpeg' } });
      }) as typeof fetch,
    });
    const [source] = await plex.sources('x');
    if (!source) throw new Error('no source');
    expect((await plex.audio(source)).subarray(0, 3).toString()).toBe('ID3');
    expect(asked).toEqual([
      'https://tvthemes.plexapp.com/81189.mp3',
      'http://tvthemes.plexapp.com/81189.mp3',
    ]);
    http = 403;
    const none = await plex.audio(source).catch((error: unknown) => error);
    expect(none).toBeInstanceOf(NoThemeError);
    expect((none as NoThemeError).detail).toBe('403 http, 404 https');
  });

  it('knows an MP3 by its first bytes', () => {
    expect(isMp3(Buffer.from('ID3\u0004'))).toBe(true);
    expect(isMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
    expect(isMp3(Buffer.from('<html>Not found</html>'))).toBe(false);
  });
});
