// Theme music from AnimeThemes for anime Plex has none for: a fake Plex and a
// fake AnimeThemes, a real FFmpeg (Ogg to MP3), against PostgreSQL.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { AnimeMap } from '../src/intro/aniskip.js';
import { AnimeThemesProvider, pickOpening } from '../src/themes/animethemes.js';
import { toMp3 } from '../src/themes/audio.js';
import { isMp3, PlexThemeProvider, ThemeService } from '../src/themes/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const map = new AnimeMap([
  // Frieren: one season in two cours (the second starts after 16 episodes).
  { mal_id: 52991, tvdb_id: 424536, season: { tvdb: 1 }, episode_offset: { tvdb: 0 } },
  { mal_id: 60000, tvdb_id: 424536, season: { tvdb: 1 }, episode_offset: { tvdb: 16 } },
  // Bleach: the TYBW seasons first in the list, the first season after them.
  { mal_id: 41467, tvdb_id: 74796, season: { tvdb: 17 }, episode_offset: { tvdb: 0 } },
  { mal_id: 269, tvdb_id: 74796, season: { tvdb: 1 }, episode_offset: { tvdb: 0 } },
  // Only known by TMDB.
  { mal_id: 777, themoviedb_id: { tv: 5555 }, season: { tmdb: 1 } },
]);

describe('the first MyAnimeList entry of a show', () => {
  it('is the first cour of its first season, by TVDB, else TMDB', () => {
    expect(map.first({ tvdbId: 424536 })).toBe(52991);
    expect(map.first({ tvdbId: 74796 })).toBe(269);
    expect(map.first({ tvdbId: 1, tmdbId: 5555 })).toBe(777);
    expect(map.first({ tvdbId: 81189 })).toBeUndefined();
  });
});

describe('picking an opening', () => {
  const video = (link: string) => ({ audio: { link } });
  it('takes OP1 before later ones and endings, and a version without spoilers', () => {
    expect(
      pickOpening({
        animethemes: [
          { type: 'ED', sequence: 1, animethemeentries: [{ videos: [video('ed1')] }] },
          { type: 'OP', sequence: 2, animethemeentries: [{ videos: [video('op2')] }] },
          {
            type: 'OP',
            sequence: 1,
            animethemeentries: [
              { version: 1, spoiler: true, videos: [video('op1-spoiler')] },
              { version: 2, videos: [{ audio: null }, video('op1v2')] },
            ],
          },
        ],
      }),
    ).toBe('op1v2');
  });

  it('has nothing without an opening with audio', () => {
    expect(pickOpening({ animethemes: [{ type: 'ED', animethemeentries: [] }] })).toBeUndefined();
    expect(pickOpening({})).toBeUndefined();
  });
});

describe.skipIf(!databaseUrl)('theme music from AnimeThemes (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let cache: string;
  let ogg: Buffer;
  const asked: string[] = [];
  const ids: Record<string, string> = {};
  let animeThemesDown = false;
  let audioFileDown = false;

  const plexFetch = (async (url: string) => {
    asked.push(url);
    // Plex has Bleach, nothing else.
    return url.endsWith('/74796.mp3')
      ? new Response(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20_000)]))
      : new Response('Not Found', { status: 404 });
  }) as typeof fetch;

  const animeFetch = (async (url: string) => {
    if (animeThemesDown) throw new TypeError('fetch failed');
    asked.push(url);
    if (url.endsWith('/Frieren-OP1.ogg')) {
      return audioFileDown ? new Response('busy', { status: 503 }) : new Response(ogg);
    }
    const mal = /filter\[external_id\]=(\d+)/.exec(decodeURIComponent(url))?.[1];
    if (mal === '52991') {
      return Response.json({
        anime: [
          {
            name: 'Frieren',
            animethemes: [
              {
                type: 'OP',
                sequence: 1,
                animethemeentries: [
                  { version: 1, videos: [{ audio: { link: 'https://a.test/Frieren-OP1.ogg' } }] },
                ],
              },
            ],
          },
        ],
      });
    }
    if (mal === '777') return Response.json({ anime: [{ name: 'Endings only', animethemes: [] }] });
    return Response.json({ anime: [] });
  }) as typeof fetch;

  const service = (now?: () => number) =>
    new ThemeService({
      prisma,
      cacheDir: cache,
      ...(now && { now }),
      providers: [
        new PlexThemeProvider(prisma, { baseUrl: 'https://plex.test', fetch: plexFetch }),
        new AnimeThemesProvider(prisma, {
          animeMap: async () => map,
          baseUrl: 'https://animethemes.test/',
          fetch: animeFetch,
        }),
      ],
    });

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe('TRUNCATE "Library", "MediaItem" CASCADE');
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-animethemes-'));
    ogg = execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
      ...['-i', 'sine=frequency=440:duration=4', '-c:a', 'libvorbis', '-f', 'ogg', 'pipe:1'],
    ]);
    const library = await prisma.library.create({
      data: { name: 'Anime', type: 'SHOWS', path: 'Anime' },
    });
    for (const [title, data] of [
      ['Frieren', { tvdbId: 424536 }],
      ['Bleach', { tvdbId: 74796 }],
      ['Endings Only', { tmdbId: 5555 }],
      ['Not Anime', { tvdbId: 81189 }],
    ] as const) {
      const item = await prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          type: 'SHOW',
          path: `Anime/${title}`,
          title,
          sortTitle: title.toLowerCase(),
          metadataStatus: 'MATCHED',
          ...data,
        },
      });
      ids[title] = item.id;
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (cache) rmSync(cache, { recursive: true, force: true });
  });

  it('makes an MP3 of Ogg audio', async () => {
    const mp3 = await toMp3(ogg);
    expect(isMp3(mp3)).toBe(true);
    expect(mp3.length).toBeGreaterThan(10_000);
  });

  it("takes an anime's opening when Plex has none, and keeps Plex's when it has one", async () => {
    const themes = service();
    const frieren = await themes.theme(ids.Frieren ?? '');
    expect(frieren).toMatchObject({ from: { source: 'animethemes' } });
    expect(frieren.url).toContain('v=mal-52991');
    expect(asked).toContain('https://plex.test/424536.mp3');
    const file = readdirSync(path.join(cache, 'themes')).find((n) => n.includes('animethemes'));
    expect(isMp3(readFileSync(path.join(cache, 'themes', file ?? '')))).toBe(true);

    const before = asked.length;
    expect(await themes.theme(ids.Bleach ?? '')).toMatchObject({ from: { source: 'plex' } });
    // Plex had it: AnimeThemes not asked.
    expect(asked.slice(before)).toEqual(['https://plex.test/74796.mp3']);
  });

  it('tells Beheer what each source answered', async () => {
    const themes = service();
    for (const name of ['Endings Only', 'Not Anime']) await themes.theme(ids[name] ?? '');
    const status = await themes.status();
    expect(status.sources).toEqual(['plex', 'animethemes']);
    expect(status.missing).toEqual([
      // No TVDB id: Plex has no source for it, AnimeThemes found the anime but no opening.
      expect.objectContaining({
        title: 'Endings Only',
        none: true,
        reason: 'AnimeThemes: geen opening',
      }),
      expect.objectContaining({ title: 'Not Anime', none: true, reason: 'Plex: 404 https' }),
    ]);
    expect(status).toMatchObject({ none: 2, failed: 0 });
  });

  it("plays the anime's opening after a restart without asking anyone", async () => {
    const before = asked.length;
    const themes = service();
    expect((await themes.ready(ids.Frieren ?? '')).url).toContain('v=mal-52991');
    expect(await themes.cached(ids.Frieren ?? '')).toBeTruthy();
    expect(asked).toHaveLength(before);
    // Fetching ahead skips it: it has a theme.
    await themes.prepare(10, 0);
    expect(asked.slice(before).some((u) => u.includes('424536'))).toBe(false);
  });

  it('waits for AnimeThemes when it is down, without stopping Plex', async () => {
    rmSync(path.join(cache, 'themes'), { recursive: true, force: true });
    const themes = service();
    animeThemesDown = true;
    expect(await themes.theme(ids.Frieren ?? '')).toMatchObject({
      url: null,
      pending: true,
      from: { source: 'animethemes' },
    });
    expect((await themes.status()).pausedSource).toBe('animethemes');
    expect((await themes.theme(ids.Bleach ?? '')).url).toBeTruthy();
    animeThemesDown = false;
    themes.retry();
    await expect.poll(async () => (await themes.ready(ids.Frieren ?? '')).url).toBeTruthy();
  });

  it('stops pausing AnimeThemes for one title whose audio file keeps answering 503', async () => {
    rmSync(path.join(cache, 'themes'), { recursive: true, force: true });
    let now = Date.now();
    const themes = service(() => now);
    audioFileDown = true;
    for (let round = 1; round <= 2; round += 1) {
      expect(await themes.theme(ids.Frieren ?? '')).toMatchObject({ url: null, pending: true });
      const status = await themes.status();
      expect(status.pausedSource).toBe('animethemes');
      expect(status.lastError?.message).toBe('AnimeThemes answered 503 (audio file, MAL 52991)');
      now += 16 * 60 * 1000;
    }
    // The third time: that title's file, not AnimeThemes; the rest goes on.
    expect(await themes.theme(ids.Frieren ?? '')).toMatchObject({ url: null, pending: false });
    const status = await themes.status();
    expect(status.pausedSource).toBeUndefined();
    expect(status.missing?.find((m) => m.itemId === ids.Frieren)?.reason).toContain(
      'AnimeThemes answered 503 (audio file, MAL 52991)',
    );
    audioFileDown = false;
  });
});
