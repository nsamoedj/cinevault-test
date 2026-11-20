// A film's end credits from the picture: what counts as credits, where a
// scene after them starts (never skipped), the whole way on a real FFmpeg film
// with the transcoder's code, and the search against PostgreSQL
// (TEST_DATABASE_URL) with a fake transcoder.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipCreditsTo } from '@cinevault/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import {
  type FrameKind,
  type FrameSample,
  filmCredits,
  frameKind,
  sampleTimes,
  windowStart,
} from '../src/intro/film.js';
import { IntroService } from '../src/intro/service.js';
import { TranscoderClient } from '../src/transcoder.js';
import { authorize, TEST_AUTH } from './auth-helpers.js';

/** What the transcoder measured on frames like these (apps/transcoder/test/frames.test.ts). */
const LOOKS: Record<FrameKind | 'dark scene' | 'stars', Omit<FrameSample, 'time' | 'at'>> = {
  credits: { dark: 0.978, mid: 0.006, bright: 0.016, rows: 43, perRow: 21 },
  black: { dark: 1, mid: 0, bright: 0, rows: 0, perRow: 0 },
  other: { dark: 0.17, mid: 0.49, bright: 0.34, rows: 180, perRow: 110 },
  'dark scene': { dark: 0.86, mid: 0.12, bright: 0.02, rows: 60, perRow: 6 },
  stars: { dark: 0.99, mid: 0.002, bright: 0.008, rows: 120, perRow: 2 },
};

/** Samples every 4 s from `from`, each its own keyframe, as `kindAt` says. */
function film(from: number, to: number, kindAt: (t: number) => keyof typeof LOOKS): FrameSample[] {
  return sampleTimes(from, to).map((t) => ({ time: t, at: t, ...LOOKS[kindAt(t)] }));
}

describe('what a frame shows', () => {
  it('knows credits, black and the rest', () => {
    expect(frameKind(LOOKS.credits)).toBe('credits');
    expect(frameKind(LOOKS.black)).toBe('black');
    expect(frameKind(LOOKS.other)).toBe('other');
    // A dark scene has its shades; the stars are no lines of text.
    expect(frameKind(LOOKS['dark scene'])).toBe('other');
    expect(frameKind(LOOKS.stars)).toBe('other');
  });

  it('looks in the last part of a film, not before its middle', () => {
    expect(windowStart(7200)).toBe(6000);
    expect(windowStart(1500)).toBe(1200);
    expect(windowStart(400)).toBe(200);
  });
});

describe('the parts of the credits', () => {
  const D = 6000;

  it('runs to the end when nothing follows (a fade to black before is part of it)', () => {
    const samples = film(5000, D, (t) =>
      t < 5400 ? 'other' : t < 5408 ? 'black' : t < 5900 ? 'credits' : 'black',
    );
    expect(filmCredits(samples, D)).toEqual([{ start: 5400, end: D }]);
  });

  it('stops at a scene after the credits, also a short one', () => {
    const samples = film(5000, D, (t) =>
      t < 5400 ? 'other' : t < 5900 ? 'credits' : t < 5908 ? 'other' : 'black',
    );
    // The scene starts at its keyframe: the skip lands there.
    expect(filmCredits(samples, D)).toEqual([{ start: 5400, end: 5900 }]);
  });

  it('keeps the part after a mid-credits scene apart', () => {
    const samples = film(5000, D, (t) =>
      t < 5400
        ? 'other'
        : t < 5600
          ? 'credits'
          : t < 5660
            ? 'other'
            : t < 5900
              ? 'credits'
              : t < 5940
                ? 'other'
                : 'black',
    );
    expect(filmCredits(samples, D)).toEqual([
      { start: 5400, end: 5600 },
      { start: 5660, end: 5900 },
    ]);
  });

  it('keeps one stray frame (a logo, a misread one) inside the credits', () => {
    const samples = film(5000, D, (t) =>
      t < 5400 ? 'other' : t === 5600 ? 'other' : t < 5990 ? 'credits' : 'black',
    );
    expect(filmCredits(samples, D)).toEqual([{ start: 5400, end: D }]);
  });

  it('finds no credits in a dark scene, a starry sky or a short text card', () => {
    expect(
      filmCredits(
        film(5000, D, () => 'dark scene'),
        D,
      ),
    ).toEqual([]);
    expect(
      filmCredits(
        film(5000, D, () => 'stars'),
        D,
      ),
    ).toEqual([]);
    // "Five years later": 12 s of text on black.
    const card = film(5000, D, (t) => (t >= 5500 && t < 5512 ? 'credits' : 'other'));
    expect(filmCredits(card, D)).toEqual([]);
  });

  it('skips part by part in the player, never over a scene', () => {
    const info = {
      credits: { startMs: 5_400_000, endMs: 5_600_000 },
      moreCredits: [{ startMs: 5_660_000, endMs: 5_900_000 }],
      creditsSource: 'picture',
    };
    expect(skipCreditsTo(info, 5450, D)).toBe(5600);
    expect(skipCreditsTo(info, 5630, D)).toBeUndefined(); // the scene
    expect(skipCreditsTo(info, 5700, D)).toBe(5900);
    // Credits to the end: nothing after them to go to.
    expect(skipCreditsTo({ ...info, moreCredits: [] }, 5450, 5600)).toBeUndefined();
  });
});

// --- A real film ---------------------------------------------------------------------

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const framesSrc = fileURLToPath(new URL('../../transcoder/src/frames.ts', import.meta.url));

describe.skipIf(!hasFfmpeg || !existsSync(FONT))('a real film (FFmpeg and the transcoder)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-film-'));
    const names = ['Directed by Jane Doe', 'Written by John Roe', 'Music by The Composer'];
    writeFileSync(path.join(dir, 'credits.txt'), Array(12).fill(names).flat().join('\n\n'));
    const credits = (seconds: number) =>
      `color=black:d=${seconds}:s=640x360:r=24,drawtext=fontfile=${FONT}:` +
      `textfile=${path.join(dir, 'credits.txt')}:fontcolor=white:fontsize=16:` +
      'x=(w-tw)/2:y=h*0.6-t*30:line_spacing=6';
    // 0-100 the film, 100-130 credits, 130-142 a mid-credits scene, 142-172 credits,
    // 172-182 a post-credit scene, 182-185 black.
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=d=100:s=640x360:r=24',
      '-f', 'lavfi', '-i', credits(30),
      '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=24,trim=duration=12',
      '-f', 'lavfi', '-i', credits(30),
      '-f', 'lavfi', '-i', 'testsrc=d=10:s=640x360:r=24',
      '-f', 'lavfi', '-i', 'color=black:d=3:s=640x360:r=24',
      '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', '120',
      path.join(dir, 'film.mkv'),
    ]);
    // Encoding takes some seconds (the Mandelbrot), more on a busy machine.
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds both parts of the credits, and the scenes between and after them', () => {
    const duration = 185;
    const times = sampleTimes(windowStart(duration), duration);
    // The transcoder's code, run by Node itself (it is TypeScript with .ts imports).
    const script = `
      import { FrameStatsJobs } from ${JSON.stringify(framesSrc)};
      const jobs = new FrameStatsJobs({ mediaRoot: ${JSON.stringify(dir)}, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, { info() {}, error() {} });
      const { samples } = await jobs.stats({ path: 'film.mkv', times: ${JSON.stringify(times)} });
      console.log(JSON.stringify(samples));
    `;
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    const parts = filmCredits(JSON.parse(output) as FrameSample[], duration);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.start).toBeCloseTo(100, 0);
    expect(parts[0]?.end).toBeCloseTo(130, 0);
    expect(parts[1]?.start).toBeCloseTo(142, 0);
    expect(parts[1]?.end).toBeCloseTo(172, 0);
  });
});

// --- The search ----------------------------------------------------------------------

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('film credits search (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let intro: IntroService;
  let cache: string;
  let movies = '';
  const asked: { path: string; times: number[]; hdr?: boolean; jobs?: number }[] = [];
  /** Per file: what the picture shows at a time. */
  const pictures: Record<string, (t: number) => keyof typeof LOOKS> = {};

  const addFilm = async (title: string, filePath: string, minutes: number, addedAt: Date) => {
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: movies,
        type: 'MOVIE',
        path: path.dirname(filePath),
        title,
        sortTitle: title.toLowerCase(),
        metadataStatus: 'MATCHED',
      },
    });
    const file = await prisma.mediaFile.create({
      data: {
        mediaItemId: item.id,
        path: filePath,
        size: 1n,
        modifiedAt: new Date('2026-10-01T00:00:00Z'),
        durationMs: minutes * 60_000,
        hdrFormat: 'HDR10',
        addedAt,
      },
    });
    return file.id;
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
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-film-cache-'));
    const transcoder = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: (async (_input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          path: string;
          times: number[];
          hdr?: boolean;
          jobs?: number;
        };
        asked.push(body);
        const picture = pictures[body.path];
        if (!picture) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({
          samples: body.times.map((t) => ({ time: t, at: t, ...LOOKS[picture(t)] })),
        });
      }) as typeof fetch,
    });
    intro = new IntroService({ prisma, transcoder, cacheDir: cache, filmPauseMs: 0 });
    movies = (
      await prisma.library.create({ data: { name: 'Movies', type: 'MOVIES', path: 'Movies' } })
    ).id;
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

  it('finds the credits of the newest film first, with the scene after them kept', async () => {
    // 100 minutes: credits from 90 min, a post-credit scene at 98 min.
    pictures['Movies/A/A.mkv'] = (t) => (t < 5400 ? 'other' : t < 5880 ? 'credits' : 'other');
    pictures['Movies/B/B.mkv'] = () => 'other';
    const a = await addFilm('A', 'Movies/A/A.mkv', 100, new Date('2026-10-20T00:00:00Z'));
    const b = await addFilm('B', 'Movies/B/B.mkv', 100, new Date('2026-10-10T00:00:00Z'));
    expect((await intro.status()).films).toBe(2);
    expect(await intro.runOnce()).toBe(true);
    // A came in last: done first, its keyframes HDR-tone-mapped.
    expect(asked.every((r) => r.path === 'Movies/A/A.mkv' && r.hdr === true)).toBe(true);
    expect(await intro.info(a)).toMatchObject({
      credits: { startMs: 5_400_000, endMs: 5_880_000 },
      creditsSource: 'picture',
      creditsPending: false,
      introPending: false,
      recapPending: false,
    });
    expect((await intro.info(b)).creditsPending).toBe(true);
    asked.length = 0;
    expect(await intro.runOnce()).toBe(true);
    expect(await intro.info(b)).toMatchObject({ creditsPending: false, pending: false });
    // All film: every third keyframe time of the last 20 minutes is enough, three at once.
    const times = asked.flatMap((r) => r.times);
    expect(times.length).toBeLessThanOrEqual(101);
    expect(asked.every((r) => r.jobs === 3)).toBe(true);
    expect((await intro.info(b)).credits).toBeUndefined();
    expect(await intro.status()).toMatchObject({ films: 2, filmsChecked: 2, filmsFound: 1 });
    // The player gets it, and where skipping goes.
    const context = (await app.inject(`/api/files/${a}`)).json();
    expect(context).toMatchObject({ credits: { startMs: 5_400_000 }, creditsSource: 'picture' });
    expect(skipCreditsTo(context, 5500, 6000)).toBe(5880);
  });

  it('keeps more parts apart, and looks further back for long credits', async () => {
    // 60 minutes; the window starts at 48 min, the credits at 40 min: looked further back.
    pictures['Movies/C/C.mkv'] = (t) =>
      t < 2400
        ? 'other'
        : t < 3000
          ? 'credits'
          : t < 3060
            ? 'other'
            : t < 3500
              ? 'credits'
              : 'black';
    const c = await addFilm('C', 'Movies/C/C.mkv', 60, new Date('2026-10-21T00:00:00Z'));
    asked.length = 0;
    expect(await intro.runOnce()).toBe(true);
    expect(Math.min(...asked.flatMap((r) => r.times))).toBeLessThan(2400);
    const info = await intro.info(c);
    expect(info.credits).toEqual({ startMs: 2_400_000, endMs: 3_000_000 });
    expect(info.moreCredits).toEqual([{ startMs: 3_060_000, endMs: 3_600_000 }]);
    // Again: everything from the cache.
    asked.length = 0;
    await app.inject({ method: 'POST', url: `/api/files/${c}/credits/detect` });
    expect((await intro.info(c)).moreCredits).toBeUndefined();
    while (await intro.runOnce());
    expect(asked).toEqual([]);
    expect((await intro.info(c)).moreCredits).toHaveLength(1);
    // By hand: one part.
    await app.inject({
      method: 'PUT',
      url: `/api/files/${c}/credits`,
      payload: { startMs: 2_500_000, endMs: 3_400_000 },
    });
    expect(await intro.info(c)).toMatchObject({ creditsSource: 'manual' });
    expect((await intro.info(c)).moreCredits).toBeUndefined();
  });
});
