// Skip Intro for anime from AniSkip: the anime-lists (TVDB season → MAL entry),
// the AniSkip answer, and the intro search using it before the fingerprints
// (fake AniSkip and transcoder; PostgreSQL from TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { AniSkip, AnimeMap, pickSkipTimes } from '../src/intro/aniskip.js';
import { IntroService } from '../src/intro/service.js';
import { TranscoderClient } from '../src/transcoder.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

// Bleach on TheTVDB: season 1 is one cour; season 17 (Thousand-Year Blood War)
// is three MAL entries, starting at episodes 1, 14 and 27.
const LIST = [
  { mal_id: 269, tvdb_id: 74796, themoviedb_id: { tv: 30984 }, season: { tvdb: 1, tmdb: 1 } },
  { mal_id: 41467, tvdb_id: 74796, season: { tvdb: 17 } },
  { mal_id: 53998, tvdb_id: 74796, season: { tvdb: 17 }, episode_offset: { tvdb: 13 } },
  { mal_id: 56784, tvdb_id: 74796, season: { tvdb: 17 }, episode_offset: { tvdb: 26 } },
  { mal_id: 834, tvdb_id: 74796, season: { tvdb: 0 } },
  { mal_id: 1, themoviedb_id: { tv: 30991 }, season: { tmdb: 1 } },
  { anidb_id: 5 },
];

describe('the anime-lists', () => {
  const map = new AnimeMap(LIST);

  it('finds the MAL entry and episode of a TVDB season, also one split in cours', () => {
    expect(map.find({ tvdbId: 74796 }, 1, 5)).toEqual({ malId: 269, episode: 5 });
    expect(map.find({ tvdbId: 74796 }, 17, 13)).toEqual({ malId: 41467, episode: 13 });
    expect(map.find({ tvdbId: 74796 }, 17, 14)).toEqual({ malId: 53998, episode: 1 });
    expect(map.find({ tvdbId: 74796 }, 17, 30)).toEqual({ malId: 56784, episode: 4 });
    // Specials aren't looked up; an unknown season gives nothing.
    expect(map.find({ tvdbId: 74796 }, 0, 1)).toBeUndefined();
    expect(map.find({ tvdbId: 74796 }, 5, 1)).toBeUndefined();
  });

  it('falls back to TMDB, and knows which shows are anime', () => {
    expect(map.find({ tvdbId: 1, tmdbId: 30991 }, 1, 3)).toEqual({ malId: 1, episode: 3 });
    expect(map.has({ tvdbId: 74796 })).toBe(true);
    expect(map.has({ tvdbId: 1234, tmdbId: 5678 })).toBe(false);
  });
});

describe('AniSkip answers', () => {
  const result = (skipType: string, startTime: number, endTime: number) => ({
    interval: { startTime, endTime },
    skipType,
    episodeLength: 1420,
  });

  it('takes the opening (else a mixed one) and the ending, when they fit', () => {
    expect(
      pickSkipTimes(
        {
          found: true,
          results: [result('mixed-op', 0, 80), result('op', 90.5, 180.5), result('ed', 1300, 1390)],
        },
        1420,
      ),
    ).toEqual({ intro: { start: 90.5, end: 180.5 }, credits: { start: 1300, end: 1390 } });
    expect(pickSkipTimes({ found: true, results: [result('mixed-op', 0, 80)] }, 1420)).toEqual({
      intro: { start: 0, end: 80 },
    });
    // Past the end of this file, or too short: not this release.
    expect(pickSkipTimes({ found: true, results: [result('op', 1500, 1590)] }, 1420)).toEqual({});
    expect(pickSkipTimes({ found: true, results: [result('op', 10, 12)] }, 1420)).toEqual({});
    expect(pickSkipTimes({ found: false, results: [] }, 1420)).toEqual({});
    expect(pickSkipTimes(undefined, 1420)).toEqual({});
  });

  it('asks for the episode with its length, and keeps the anime-lists in the cache', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'cinevault-aniskip-'));
    const asked: string[] = [];
    let listUp = true;
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith('https://lists.test/')) {
        return listUp ? Response.json(LIST) : new Response('down', { status: 503 });
      }
      if (url.includes('/skip-times/269/5')) {
        return Response.json({ found: true, results: [result('op', 30, 120)] });
      }
      return Response.json({ found: false, results: [], statusCode: 404 }, { status: 404 });
    }) as typeof fetch;
    let now = Date.now();
    const options = {
      cacheDir: cache,
      aniskipUrl: 'https://aniskip.test',
      animeListUrl: 'https://lists.test/anime-list-mini.json',
      fetch: fetchFn,
      now: () => now,
    };
    const aniskip = new AniSkip(options);
    expect((await aniskip.animeMap())?.has({ tvdbId: 74796 })).toBe(true);
    expect(existsSync(path.join(cache, 'aniskip', 'anime-list.json'))).toBe(true);

    expect(await aniskip.skipTimes(269, 5, 1420.4)).toEqual({ intro: { start: 30, end: 120 } });
    expect(asked).toContain(
      'https://aniskip.test/v2/skip-times/269/5?types=op&types=ed&types=mixed-op&types=mixed-ed&types=recap&episodeLength=1420',
    );
    expect(await aniskip.skipTimes(269, 6, 1420)).toEqual({});

    // A new process reads the list from the cache; a week later the list is
    // fetched again, and while that fails the old one is used.
    listUp = false;
    asked.length = 0;
    expect((await new AniSkip(options).animeMap())?.has({ tvdbId: 74796 })).toBe(true);
    expect(asked).toEqual([]);
    now += 8 * 24 * 60 * 60 * 1000;
    expect((await new AniSkip(options).animeMap())?.has({ tvdbId: 74796 })).toBe(true);
    expect(asked).toEqual(['https://lists.test/anime-list-mini.json']);
    rmSync(cache, { recursive: true, force: true });
  });
});

describe.skipIf(!databaseUrl)('intro search with AniSkip (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let cache: string;
  let now = Date.parse('2026-10-19T12:00:00Z');
  const fingerprinted: string[] = [];
  const asked: string[] = [];
  let aniskipUp = true;
  const files: Record<string, string> = {};

  const fetchFn = (async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith('https://lists.test/')) return Response.json(LIST);
    asked.push(url.replace(/\?.*/, ''));
    if (!aniskipUp) return new Response('down', { status: 503 });
    const times: Record<string, unknown[]> = {
      '/v2/skip-times/269/1': [
        { interval: { startTime: 85, endTime: 175 }, skipType: 'op' },
        { interval: { startTime: 1300, endTime: 1390 }, skipType: 'ed' },
      ],
      '/v2/skip-times/53998/1': [{ interval: { startTime: 0, endTime: 90 }, skipType: 'op' }],
    };
    const found = times[new URL(url).pathname];
    return found
      ? Response.json({ found: true, results: found })
      : Response.json({ found: false, results: [] }, { status: 404 });
  }) as typeof fetch;

  const makeIntro = () =>
    new IntroService({
      prisma,
      cacheDir: cache,
      now: () => now,
      aniskip: new AniSkip({
        cacheDir: cache,
        aniskipUrl: 'https://aniskip.test',
        animeListUrl: 'https://lists.test/anime-list-mini.json',
        fetch: fetchFn,
        now: () => now,
      }),
      transcoder: new TranscoderClient({
        url: 'http://transcoder',
        token: 'secret-token-1234567890',
        fetch: (async (_input: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { path: string; start?: number };
          fingerprinted.push(body.start ? `${body.path} @end` : body.path);
          // Nothing readable: the search finds nothing, which is enough here.
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }) as typeof fetch,
      }),
    });

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "User", "Session" CASCADE',
    );
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-aniskip-db-'));
    const library = await prisma.library.create({
      data: { name: 'Anime', type: 'SHOWS', path: 'Anime' },
    });
    const show = async (title: string, tvdbId: number | null, episodes: [number, number][]) => {
      const item = await prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          type: 'SHOW',
          path: `Anime/${title}`,
          title,
          sortTitle: title.toLowerCase(),
          tvdbId,
          metadataStatus: 'MATCHED',
        },
      });
      for (const [seasonNumber, episodeNumber] of episodes) {
        const season = await prisma.season.upsert({
          where: { mediaItemId_seasonNumber: { mediaItemId: item.id, seasonNumber } },
          create: { mediaItemId: item.id, seasonNumber },
          update: {},
        });
        const episode = await prisma.episode.create({
          data: { seasonId: season.id, episodeNumber },
        });
        const file = await prisma.mediaFile.create({
          data: {
            episodeId: episode.id,
            path: `Anime/${title}/S${seasonNumber}E${episodeNumber}.mkv`,
            size: 1n,
            modifiedAt: new Date('2026-10-01T00:00:00Z'),
            addedAt: new Date('2026-10-10T00:00:00Z'),
            durationMs: 1_420_000,
          },
        });
        files[`${title} ${seasonNumber}x${episodeNumber}`] = file.id;
      }
    };
    await show('Bleach', 74796, [
      [1, 1],
      [1, 2],
      [17, 14],
    ]);
    await show('Western', 99999, [[1, 1]]);
  });

  beforeEach(() => {
    fingerprinted.length = 0;
    asked.length = 0;
    aniskipUp = true;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(cache, { recursive: true, force: true });
  });

  it('takes the intro and credits from AniSkip, without reading the file', async () => {
    const info = await makeIntro().analyze(files['Bleach 1x1'] ?? '');
    expect(info).toMatchObject({
      intro: { startMs: 85_000, endMs: 175_000 },
      source: 'aniskip',
      credits: { startMs: 1_300_000, endMs: 1_390_000 },
      creditsSource: 'aniskip',
      pending: false,
    });
    expect(asked).toEqual(['https://aniskip.test/v2/skip-times/269/1']);
    expect(fingerprinted).toEqual([]);
  });

  it('asks the right cour of a split season, and reads the audio for what AniSkip lacks', async () => {
    const info = await makeIntro().analyze(files['Bleach 17x14'] ?? '');
    expect(asked).toEqual(['https://aniskip.test/v2/skip-times/53998/1']);
    expect(info).toMatchObject({ intro: { startMs: 0, endMs: 90_000 }, source: 'aniskip' });
    // No ending on AniSkip: the credits come from the fingerprints (and the
    // recap from the clips of the episode before, at the start).
    expect(fingerprinted).toEqual(['Anime/Bleach/S17E14.mkv @end', 'Anime/Bleach/S17E14.mkv']);
    expect(info.credits).toBeUndefined();
  });

  it('reads the audio for shows AniSkip does not know', async () => {
    await makeIntro().analyze(files['Western 1x1'] ?? '');
    expect(asked).toEqual([]);
    expect(fingerprinted).toHaveLength(2);
    const file = await prisma.mediaFile.findUniqueOrThrow({ where: { id: files['Western 1x1'] } });
    expect(file.aniskipCheckedAt).not.toBeNull();
  });

  it('asks AniSkip again later for what the audio found, but keeps what an admin set', async () => {
    const id = files['Bleach 1x2'] ?? '';
    const other = files['Bleach 1x1'] ?? '';
    // Searched before AniSkip was used: the audio found an intro; an admin set the
    // credits of episode 1 by hand.
    await prisma.mediaFile.update({
      where: { id },
      data: {
        introStartMs: 80_000,
        introEndMs: 170_000,
        introSource: 'audio',
        introCheckedAt: new Date(now),
        creditsCheckedAt: new Date(now),
        aniskipCheckedAt: null,
      },
    });
    await prisma.mediaFile.update({
      where: { id: other },
      data: {
        creditsStartMs: 1_000_000,
        creditsEndMs: 1_050_000,
        creditsSource: 'manual',
        aniskipCheckedAt: null,
      },
    });
    const intro = makeIntro();
    // Episode 2, and episode 1 for a recap AniSkip may know by now.
    expect(await intro.aniskipPass()).toBe(2);
    const [two, one] = await Promise.all([
      prisma.mediaFile.findUniqueOrThrow({ where: { id } }),
      prisma.mediaFile.findUniqueOrThrow({ where: { id: other } }),
    ]);
    // Episode 2 isn't on AniSkip yet: what the audio found stays.
    expect(two).toMatchObject({ introSource: 'audio', introStartMs: 80_000 });
    expect(two.aniskipCheckedAt).not.toBeNull();
    expect(one).toMatchObject({ creditsSource: 'manual', creditsStartMs: 1_000_000 });
    // Asked again only after a few days.
    expect(await intro.aniskipPass()).toBe(0);
    // Recent episodes whose credits, intro (or recap) only the audio could look for.
    now += 4 * 24 * 60 * 60 * 1000;
    expect(await intro.aniskipPass()).toBe(4);
  });

  it('leaves AniSkip alone for a while when it is down', async () => {
    const id = files['Bleach 1x2'] ?? '';
    await prisma.mediaFile.update({ where: { id }, data: { aniskipCheckedAt: null } });
    aniskipUp = false;
    const intro = makeIntro();
    expect(await intro.aniskipPass()).toBe(0);
    const calls = asked.length;
    expect(calls).toBeGreaterThan(0);
    expect(await intro.aniskipPass()).toBe(0);
    expect(asked.length).toBe(calls);
    const file = await prisma.mediaFile.findUniqueOrThrow({ where: { id } });
    expect(file.aniskipCheckedAt).toBeNull();
  });
});
