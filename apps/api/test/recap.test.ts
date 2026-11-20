// Skip Recap: the clips of the episode before near the start of an episode,
// a "Recap" chapter, and the search and routes with a fake transcoder
// against PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { pickRecap, recapChapter, sharedClips } from '../src/intro/match.js';
import { IntroService } from '../src/intro/service.js';
import { TranscoderClient } from '../src/transcoder.js';
import { authorize, TEST_AUTH } from './auth-helpers.js';

const HOP = 341 / 11025;
const frames = (s: number) => Math.round(s / HOP);

function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function noise(seconds: number, seed: number): Uint32Array {
  const next = random(seed);
  return Uint32Array.from({ length: frames(seconds) }, () => next());
}

/** `into` with the audio of `from` (at `fromAt` s, `length` s long) at `at` s, a few bits off. */
function paste(into: Uint32Array, from: Uint32Array, fromAt: number, length: number, at: number) {
  const next = random(at * 1000 + fromAt);
  for (let i = 0; i < frames(length); i++) {
    let value = from[frames(fromAt) + i] ?? 0;
    for (let k = 0; k < 3; k++) if (next() % 4 === 0) value ^= 1 << (next() % 32);
    into[frames(at) + i] = value >>> 0;
  }
}

function encode(values: Uint32Array): string {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeUInt32LE(value, i * 4));
  return buffer.toString('base64');
}

/** The episode before: 600 s of its start, and its last 600 s (from 900 s). */
const previousStart = noise(600, 1);
const previousEnd = noise(600, 2);
const tune = noise(45, 3);
paste(previousStart, tune, 0, 45, 60);

/** This episode: a recap of four clips from 0 to 42 s, the intro at 45 s, and more. */
function withRecap(seed: number): Uint32Array {
  const start = noise(600, seed);
  paste(start, previousStart, 150, 9, 1);
  paste(start, previousStart, 320, 8, 12);
  paste(start, previousStart, 470, 10, 22);
  paste(start, previousEnd, 200, 9, 33); // the cliffhanger, from the end
  paste(start, tune, 0, 45, 45);
  return start;
}

describe('finding the recap', () => {
  it('finds the clips of the episode before, each at its own place', () => {
    const own = withRecap(10);
    const clips = sharedClips(own, previousStart, HOP);
    const near = (a: number, b: number) => Math.abs(a - b) < 1;
    expect(clips.some((c) => near(c.start, 1) && near(c.otherStart, 150))).toBe(true);
    expect(clips.some((c) => near(c.start, 12) && near(c.otherStart, 320))).toBe(true);
    expect(clips.some((c) => near(c.start, 22) && near(c.end, 32) && near(c.otherStart, 470))).toBe(
      true,
    );
    // The intro too (the theme tune of both): pickRecap leaves it out.
    expect(clips.some((c) => near(c.start, 45) && near(c.otherStart, 60))).toBe(true);
    const fromEnd = sharedClips(own, previousEnd, HOP);
    expect(fromEnd.some((c) => near(c.start, 33) && near(c.otherStart, 200))).toBe(true);
  });

  it('makes one recap of the clips near the start, up to the intro', () => {
    const own = withRecap(11);
    const clips = [
      ...sharedClips(own, previousStart, HOP),
      ...sharedClips(own, previousEnd, HOP).map((c) => ({ ...c, otherStart: c.otherStart + 900 })),
    ].sort((a, b) => a.start - b.start);
    const recap = pickRecap({
      clips,
      intro: { start: 45, end: 90 },
      previousIntro: { start: 60, end: 105 },
    });
    expect(recap?.start).toBe(0);
    expect(recap?.end).toBe(45);
  });

  it('is no recap: the intro alone, a preview of this episode, a short clip, or one later on', () => {
    const intro = { start: 45, end: 90, otherStart: 60 };
    expect(pickRecap({ clips: [intro], intro: { start: 45, end: 90 } })).toBeUndefined();
    // The episode before showed this one's start after its credits (a preview).
    const preview = [
      { start: 1, end: 10, otherStart: 1400 },
      { start: 12, end: 20, otherStart: 1410 },
      { start: 22, end: 31, otherStart: 1420 },
    ];
    expect(
      pickRecap({ clips: preview, previousCredits: { start: 1320, end: 1390 } }),
    ).toBeUndefined();
    expect(pickRecap({ clips: preview })).toEqual({ start: 0, end: 31 });
    // The same music under a scene: one short clip.
    expect(pickRecap({ clips: [{ start: 3, end: 14, otherStart: 400 }] })).toBeUndefined();
    // Clips far from the start and the intro: a flashback, not a recap.
    expect(
      pickRecap({
        clips: preview.map((c) => ({ ...c, start: c.start + 400, end: c.end + 400 })),
        intro: { start: 45, end: 90 },
      }),
    ).toBeUndefined();
    // After the intro (a cold open, the intro, then the recap) it is one.
    expect(
      pickRecap({
        clips: preview.map((c) => ({ ...c, start: c.start + 130, end: c.end + 130 })),
        intro: { start: 60, end: 120 },
      }),
    ).toEqual({ start: 131, end: 161 });
  });

  it('takes short clips under narration, from many places, as a recap', () => {
    // Four clips of 2 s each over 40 s: the narrator talks between them.
    const clips = [0, 1, 2, 3].map((k) => ({
      start: 2 + k * 11,
      end: 4.5 + k * 11,
      otherStart: 100 + k * 200,
    }));
    expect(pickRecap({ clips })).toEqual({ start: 0, end: 37.5 });
    // From two places only, that little is no recap.
    const two = clips.map((c, k) => ({ ...c, otherStart: k < 2 ? 100 + k : 500 + k }));
    expect(pickRecap({ clips: two })).toBeUndefined();
  });

  it('finds clips of 1.5 s', () => {
    const own = noise(600, 90);
    paste(own, previousStart, 200, 1.7, 5);
    const clips = sharedClips(own, previousStart, HOP);
    expect(clips).toHaveLength(1);
    expect(clips[0]?.otherStart).toBeCloseTo(200, 0);
  });

  it('knows recap chapters by name', () => {
    expect(
      recapChapter([
        { start: 0, end: 50, title: 'Previously on Show' },
        { start: 50, end: 140, title: 'Opening' },
      ]),
    ).toEqual({ start: 0, end: 50 });
    expect(recapChapter([{ start: 0, end: 40, title: 'Recap' }])).toEqual({ start: 0, end: 40 });
    expect(recapChapter([{ start: 0, end: 40, title: 'Prologue' }])).toBeUndefined();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('recap search (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let intro: IntroService;
  let cache: string;
  const files: Record<string, string> = {};
  const prints: Record<string, { frames: Uint32Array; chapters: unknown[] }> = {};
  const endPrints: Record<string, { frames: Uint32Array; chapters: unknown[] }> = {};
  /** The middle of a 1500 s episode: from 600 s, 480 s long (between the start and the end). */
  const middlePrints: Record<string, { frames: Uint32Array; chapters: unknown[] }> = {};
  let show = '';
  let season1 = '';
  /** The transcoder is not running; and files whose read takes too long (408). */
  let away = false;
  const slow = new Set<string>();
  const asked: { path: string; start?: number; seconds: number; readrate?: number }[] = [];
  /** Files whose credits were looked for in the picture, and where they show credits. */
  const framesAsked: string[] = [];
  const creditsInPicture = new Map<string, number>();

  const add = async (
    key: string,
    seasonId: string,
    n: number,
    filePath: string,
    createdAt = new Date(),
  ) => {
    const episodeRow = await prisma.episode.create({
      data: { seasonId, episodeNumber: n, title: key },
    });
    const file = await prisma.mediaFile.create({
      data: {
        episodeId: episodeRow.id,
        path: filePath,
        size: 1n,
        modifiedAt: new Date('2026-10-01T00:00:00Z'),
        durationMs: 1_500_000,
        audioTracks: [{ index: 1, codec: 'aac', default: true }],
        createdAt,
      },
    });
    files[key] = file.id;
  };

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "User", "Session" CASCADE',
    );
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-recap-cache-'));
    const transcoder = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: (async (input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          path: string;
          start?: number;
          seconds: number;
          readrate?: number;
          times?: number[];
        };
        if (away) throw new TypeError('fetch failed');
        if (String(input).endsWith('/frames')) {
          // Credits from the picture (no shared closing song): a scene, no credits.
          framesAsked.push(body.path);
          const scene = { dark: 0.2, mid: 0.5, bright: 0.3, rows: 180, perRow: 100 };
          const text = { dark: 0.98, mid: 0.005, bright: 0.015, rows: 20, perRow: 20 };
          const from = creditsInPicture.get(body.path) ?? Infinity;
          return Response.json({
            samples: (body.times ?? []).map((t) => ({
              time: t,
              at: t,
              ...(t >= from ? text : scene),
            })),
          });
        }
        asked.push(body);
        if (slow.has(body.path)) {
          return Response.json({ error: 'too slow' }, { status: 408 });
        }
        const from = body.start === 600 ? middlePrints : body.start ? endPrints : prints;
        const print = from[body.path];
        if (!print) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        return Response.json({
          hop: HOP,
          count: print.frames.length,
          frames: encode(print.frames),
          chapters: print.chapters,
          start: body.start ?? 0,
        });
      }) as typeof fetch,
    });
    intro = new IntroService({ prisma, transcoder, cacheDir: cache });

    const library = await prisma.library.create({
      data: { name: 'Series', type: 'SHOWS', path: 'Series' },
    });
    show = (
      await prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          type: 'SHOW',
          path: 'Series/Show',
          title: 'Show',
          sortTitle: 'show',
          metadataStatus: 'MATCHED',
        },
      })
    ).id;
    // Season 1: episode 1, and 2 with a recap of 1; season 2: episode 1 with a
    // recap chapter.
    const one = await prisma.season.create({ data: { mediaItemId: show, seasonNumber: 1 } });
    const two = await prisma.season.create({ data: { mediaItemId: show, seasonNumber: 2 } });
    season1 = one.id;
    await add('S1E1', one.id, 1, 'Series/Show/S01E01.mkv');
    await add('S1E2', one.id, 2, 'Series/Show/S01E02.mkv');
    await add('S2E1', two.id, 1, 'Series/Show/S02E01.mkv');
    prints['Series/Show/S01E01.mkv'] = { frames: previousStart, chapters: [] };
    endPrints['Series/Show/S01E01.mkv'] = { frames: previousEnd, chapters: [] };
    prints['Series/Show/S01E02.mkv'] = { frames: withRecap(20), chapters: [] };
    endPrints['Series/Show/S01E02.mkv'] = { frames: noise(600, 21), chapters: [] };
    prints['Series/Show/S02E01.mkv'] = {
      frames: noise(600, 30),
      chapters: [
        { start: 0, end: 52, title: 'Previously on Show' },
        { start: 52, end: 1500, title: 'Episode' },
      ],
    };
    endPrints['Series/Show/S02E01.mkv'] = { frames: noise(600, 31), chapters: [] };

    const services = { prisma, scanner: {}, metadata: {}, images: {}, mediaRoot: '/media', intro };
    app = authorize(
      await buildApp({
        checkDatabase: async () => {},
        services: services as unknown as AppServices,
        auth: TEST_AUTH,
      }),
    );
  });

  afterAll(async () => {
    intro?.stop();
    await app?.close();
    await prisma?.$disconnect();
    rmSync(cache, { recursive: true, force: true });
  });

  it('finds no recap in the first episode, and the clips of it in the second', async () => {
    expect((await intro.analyze(files.S1E1 ?? '')).recap).toBeUndefined();
    const info = await intro.analyze(files.S1E2 ?? '');
    expect(info.recapSource).toBe('audio');
    expect(info.recap?.startMs).toBe(0);
    // Up to where the intro starts (the theme tune both share).
    expect((info.recap?.endMs ?? 0) / 1000).toBeCloseTo(45, 0);
    expect(info.recapPending).toBe(false);
    const context = await app.inject(`/api/files/${files.S1E2}`);
    expect(context.json().recap).toEqual(info.recap);
  });

  it('takes a recap chapter, with the season before as the episode before', async () => {
    const info = await intro.analyze(files.S2E1 ?? '');
    expect(info).toMatchObject({ recap: { startMs: 0, endMs: 52_000 }, recapSource: 'chapter' });
  });

  it('lets an admin set and clear the recap', async () => {
    const set = await app.inject({
      method: 'PUT',
      url: `/api/files/${files.S1E1}/recap`,
      payload: { startMs: 5_000, endMs: 60_000 },
    });
    expect(set.json()).toMatchObject({
      recap: { startMs: 5_000, endMs: 60_000 },
      recapSource: 'manual',
    });
    const cleared = await app.inject({ method: 'DELETE', url: `/api/files/${files.S1E1}/recap` });
    expect(cleared.json().recap).toBeUndefined();
    const redo = await app.inject({ method: 'POST', url: `/api/files/${files.S1E1}/recap/detect` });
    expect(redo.json()).toMatchObject({ recapPending: true, pending: true });
    const status = await app.inject('/api/intro/status');
    expect(status.json()).toMatchObject({ recapFound: 2 });
  });

  it('finds clips of the middle of the episode before, and of the one before that', async () => {
    // Episode 3 came later: its recap shows the middle of episode 2 and the start of episode 1.
    const middle = noise(480, 40);
    middlePrints['Series/Show/S01E02.mkv'] = { frames: middle, chapters: [] };
    const start = noise(600, 41);
    paste(start, middle, 100, 10, 2); // 700 s into episode 2
    paste(start, previousStart, 400, 9, 14); // episode 1
    paste(start, middle, 300, 10, 25); // 900 s into episode 2
    paste(start, tune, 0, 45, 40);
    prints['Series/Show/S01E03.mkv'] = { frames: start, chapters: [] };
    endPrints['Series/Show/S01E03.mkv'] = { frames: noise(600, 42), chapters: [] };
    await add('S1E3', season1, 3, 'Series/Show/S01E03.mkv');
    const info = await intro.analyze(files.S1E3 ?? '');
    expect(info.recapSource).toBe('audio');
    expect(info.recap?.startMs).toBe(0);
    // Up to the intro (the tune, at 40 s).
    expect((info.recap?.endMs ?? 0) / 1000).toBeCloseTo(40, 0);
  });

  it('looks again at an episode that had nothing to compare with when a new one comes', async () => {
    const fresh = await prisma.season.create({ data: { mediaItemId: show, seasonNumber: 3 } });
    const first = noise(600, 50);
    paste(first, tune, 0, 45, 30);
    prints['Series/Show/S03E01.mkv'] = { frames: first, chapters: [] };
    endPrints['Series/Show/S03E01.mkv'] = { frames: noise(600, 51), chapters: [] };
    await add('S3E1', fresh.id, 1, 'Series/Show/S03E01.mkv');
    // Alone in its season, and season 2 (S2E1) doesn't have the tune.
    const alone = await intro.analyze(files.S3E1 ?? '');
    expect(alone.intro).toBeUndefined();
    expect(alone.introPending).toBe(false);

    const second = noise(600, 52);
    paste(second, tune, 0, 45, 50);
    prints['Series/Show/S03E02.mkv'] = { frames: second, chapters: [] };
    endPrints['Series/Show/S03E02.mkv'] = { frames: noise(600, 53), chapters: [] };
    await add('S3E2', fresh.id, 2, 'Series/Show/S03E02.mkv', new Date(Date.now() + 5_000));
    const found = await intro.analyze(files.S3E2 ?? '');
    expect((found.intro?.startMs ?? 0) / 1000).toBeCloseTo(50, 0);
    // Episode 1 is open again, and now finds it too.
    expect((await intro.info(files.S3E1 ?? '')).introPending).toBe(true);
    const again = await intro.analyze(files.S3E1 ?? '');
    expect((again.intro?.startMs ?? 0) / 1000).toBeCloseTo(30, 0);
    // Once: episode 2, looked at after episode 1 came, stays as it is.
    expect((await intro.info(files.S3E2 ?? '')).introPending).toBe(false);
  });

  it('searches everything at once, also while people watch, when asked', async () => {
    const all = await app.inject({ method: 'POST', url: '/api/intro/run', payload: { all: true } });
    expect(all.statusCode).toBe(202);
    expect(all.json()).toMatchObject({ rush: true });
    // Someone watches: the quiet search would wait; this one goes on.
    intro.activity.touch();
    // First the intro and the credits of every episode, then the recaps.
    const episodes = (await intro.status()).episodes;
    for (let i = 0; i < episodes; i++) expect(await intro.runOnce()).toBe(true);
    const first = await intro.status();
    expect(first).toMatchObject({ checked: episodes, creditsChecked: episodes });
    // Only the ones opened earlier (still first in line) had all of them at once.
    expect(first.recapChecked).toBeLessThanOrEqual(2);
    expect(first.recapChecked).toBeLessThan(episodes);
    let rounds = episodes;
    while (await intro.runOnce()) rounds++;
    const status = (await app.inject('/api/intro/status')).json();
    expect(rounds).toBeGreaterThan(0);
    expect(status.rush).toBeUndefined();
    expect(status).toMatchObject({
      checked: status.episodes,
      creditsChecked: status.episodes,
      recapChecked: status.episodes,
    });
    // What an admin set by hand stays.
    const manual = await prisma.mediaFile.count({ where: { recapSource: 'manual' } });
    expect(manual).toBe(0);
    // Back to the quiet search: watching makes it wait again.
    await app.inject({ method: 'POST', url: '/api/intro/run', payload: { all: true } });
    const stopped = await app.inject({ method: 'DELETE', url: '/api/intro/run' });
    expect(stopped.json().rush).toBeUndefined();
    intro.activity.touch();
    expect(await intro.runOnce()).toBe(false);
  });

  it('reads no piece slower than 150 s, whatever the bitrate', () => {
    expect(asked.length).toBeGreaterThan(0);
    for (const body of asked) {
      expect(body.seconds / (body.readrate ?? 1)).toBeLessThanOrEqual(150);
    }
  });

  it('goes on past a file that reads too slowly, and stops when the transcoder stays away', async () => {
    await prisma.mediaFile.updateMany({ data: { introCheckedAt: null } });
    slow.add('Series/Show/S01E01.mkv');
    for (const name of readdirSync(path.join(cache, 'intro'))) {
      if (name.startsWith(files.S1E1 ?? '-')) rmSync(path.join(cache, 'intro', name));
    }
    asked.length = 0;
    await intro.searchAll();
    while (await intro.runOnce());
    let status = await intro.status();
    // The slow one is marked (nothing found), the rest is done.
    expect(status).toMatchObject({ checked: status.episodes });
    expect(status.rush).toBeUndefined();
    expect(status.rushStopped).toBeUndefined();
    expect((await intro.info(files.S1E1 ?? '')).intro).toBeUndefined();
    expect(asked.some((body) => body.path === 'Series/Show/S01E01.mkv')).toBe(true);
    slow.clear();

    await prisma.mediaFile.updateMany({ data: { introCheckedAt: null } });
    // Nothing from the cache: every file needs the transcoder.
    rmSync(path.join(cache, 'intro'), { recursive: true, force: true });
    away = true;
    await intro.searchAll();
    // The same file each time is no sign it can't be marked: it tries again, ten times.
    for (let i = 0; i < 9; i++) {
      expect(await intro.runOnce()).toBe(false);
      expect((await intro.status()).rush).toBe(true);
    }
    expect(await intro.runOnce()).toBe(false);
    status = await intro.status();
    expect(status).toMatchObject({ waiting: 'transcoder', rushStopped: 'transcoder' });
    expect(status.rush).toBeUndefined();
    away = false;
    await intro.searchAll();
    while (await intro.runOnce());
    status = await intro.status();
    expect(status.rushStopped).toBeUndefined();
    expect(status.checked).toBe(status.episodes);
  });

  it('reads the episode before whole only while its season may have recaps', async () => {
    away = false;
    const four = await prisma.season.create({ data: { mediaItemId: show, seasonNumber: 4 } });
    for (const n of [1, 2, 3, 4, 5]) {
      const file = `Series/Show/S04E0${n}.mkv`;
      await add(`S4E${n}`, four.id, n, file);
      prints[file] = { frames: noise(600, 50 + n), chapters: [] };
      endPrints[file] = { frames: noise(600, 60 + n), chapters: [] };
    }
    const middleOf = (n: number) =>
      asked.filter((body) => body.path === `Series/Show/S04E0${n}.mkv` && body.start === 600);
    for (const n of [1, 2, 3, 4]) {
      expect((await intro.analyze(files[`S4E${n}`] ?? '')).recap).toBeUndefined();
    }
    // Episodes 2-4 had no recap, each with all of the one before read.
    expect(middleOf(1)).toHaveLength(1);
    expect(middleOf(3)).toHaveLength(1);
    // So the fifth compares with the start and the end of the fourth only.
    expect((await intro.analyze(files.S4E5 ?? '')).recapPending).toBe(false);
    expect(middleOf(4)).toHaveLength(0);
    expect(asked.some((body) => body.path === 'Series/Show/S04E04.mkv' && body.start === 900)).toBe(
      true,
    );
  });

  it('finds clips of older episodes in the cache, without reading them again', async () => {
    // Episode 6 recaps the start of episode 1 and the end of episode 2 (four and five back).
    const own = noise(600, 66);
    const one = prints['Series/Show/S04E01.mkv']?.frames ?? new Uint32Array(0);
    const two = endPrints['Series/Show/S04E02.mkv']?.frames ?? new Uint32Array(0);
    paste(own, one, 100, 8, 1);
    paste(own, two, 300, 9, 11);
    paste(own, one, 420, 8, 22);
    paste(own, two, 500, 9, 32);
    const file = 'Series/Show/S04E06.mkv';
    prints[file] = { frames: own, chapters: [] };
    endPrints[file] = { frames: noise(600, 67), chapters: [] };
    const four = await prisma.episode.findFirst({
      where: {
        id:
          (await prisma.mediaFile.findUnique({ where: { id: files.S4E1 ?? '' } }))?.episodeId ?? '',
      },
    });
    await add('S4E6', four?.seasonId ?? '', 6, file);
    asked.length = 0;
    const info = await intro.analyze(files.S4E6 ?? '');
    expect(info.recapSource).toBe('audio');
    expect(info.recap?.startMs).toBe(0);
    expect((info.recap?.endMs ?? 0) / 1000).toBeCloseTo(41, 0);
    const older = ['Series/Show/S04E01.mkv', 'Series/Show/S04E02.mkv'];
    expect(asked.some((body) => older.includes(body.path))).toBe(false);
  });

  it('finds credits under a song of their own in the picture', async () => {
    const five = await prisma.season.create({ data: { mediaItemId: show, seasonNumber: 5 } });
    for (const n of [1, 2]) {
      const file = `Series/Show/S05E0${n}.mkv`;
      await add(`S5E${n}`, five.id, n, file);
      prints[file] = { frames: noise(600, 70 + n), chapters: [] };
      endPrints[file] = { frames: noise(600, 80 + n), chapters: [] };
    }
    // Episode 1: text on black from 1200 s to the end; episode 2: nothing in the picture.
    creditsInPicture.set('Series/Show/S05E01.mkv', 1200);
    framesAsked.length = 0;
    const one = await intro.analyze(files.S5E1 ?? '');
    expect(one.creditsSource).toBe('picture');
    expect(one.credits).toEqual({ startMs: 1_200_000, endMs: 1_500_000 });
    expect(framesAsked).toContain('Series/Show/S05E01.mkv');
    const two = await intro.analyze(files.S5E2 ?? '');
    expect(two.credits).toBeUndefined();
    expect(two.creditsPending).toBe(false);
  });
});

describe('TranscoderClient.fingerprint', () => {
  it('takes a timeout that is no whole number (AbortSignal.timeout would throw)', async () => {
    const client = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: (async () =>
        Response.json({ hop: HOP, count: 0, frames: '', chapters: [], start: 0 })) as typeof fetch,
    });
    await expect(
      client.fingerprint({ path: 'a.mkv', seconds: 568 }, 107_333.33),
    ).resolves.toMatchObject({ hop: HOP });
  });

  it('gives up after its timeout with a 408, and cancels the request', async () => {
    let cancelled = false;
    const client = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: ((_input: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            cancelled = true;
            reject(init.signal?.reason);
          });
        })) as typeof fetch,
    });
    await expect(client.fingerprint({ path: 'a.mkv', seconds: 600 }, 50)).rejects.toMatchObject({
      statusCode: 408,
    });
    expect(cancelled).toBe(true);
  });
});
