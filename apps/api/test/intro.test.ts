// Skip Intro: matching fingerprints, chapters, the search with a fake
// transcoder against PostgreSQL (TEST_DATABASE_URL), and a run on real audio
// with the transcoder's own fingerprint code and FFmpeg.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import {
  CREDITS_LIMITS,
  creditsChapter,
  decodeFrames,
  introChapter,
  pickIntro,
  pickShared,
  sharedSegment,
  sharedSegments,
} from '../src/intro/match.js';
import { IntroService } from '../src/intro/service.js';
import { TranscoderClient } from '../src/transcoder.js';
import { authorize, TEST_AUTH } from './auth-helpers.js';

const HOP = 341 / 11025;

/** A deterministic random generator, so the tests are the same every time. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

/** Frames of noise with `tune` at `at` (frames), a few bits flipped as another codec would. */
function episode(length: number, tune: Uint32Array, at: number, seed: number): Uint32Array {
  const next = random(seed);
  const frames = new Uint32Array(length);
  for (let i = 0; i < length; i++) frames[i] = next();
  tune.forEach((value, i) => {
    let flipped = value;
    for (let k = 0; k < 3; k++) if (next() % 4 === 0) flipped ^= 1 << (next() % 32);
    if (at + i < length) frames[at + i] = flipped >>> 0;
  });
  return frames;
}

function encode(frames: Uint32Array): string {
  const buffer = Buffer.alloc(frames.length * 4);
  frames.forEach((value, i) => buffer.writeUInt32LE(value, i * 4));
  return buffer.toString('base64');
}

const seconds = (s: number) => Math.round(s / HOP);
const tune = (() => {
  const next = random(42);
  return Uint32Array.from({ length: seconds(45) }, () => next());
})();
/** The closing song: longer than a theme tune. */
const closing = (() => {
  const next = random(77);
  return Uint32Array.from({ length: seconds(80) }, () => next());
})();

describe('matching fingerprints', () => {
  it('finds a shared tune at its place in each episode', () => {
    const a = episode(seconds(600), tune, seconds(70), 1);
    const b = episode(seconds(600), tune, seconds(12), 2);
    const segment = sharedSegment(a, b, HOP);
    expect(segment).toBeDefined();
    expect(segment?.start).toBeCloseTo(70, 0);
    expect(segment?.end).toBeCloseTo(115, 0);
    expect(segment?.otherStart).toBeCloseTo(12, 0);
  });

  it('finds nothing between unrelated episodes, or a match too short or too long', () => {
    expect(
      sharedSegment(
        episode(seconds(600), new Uint32Array(0), 0, 3),
        episode(seconds(600), new Uint32Array(0), 0, 4),
        HOP,
      ),
    ).toBeUndefined();
    const jingle = tune.slice(0, seconds(5));
    expect(
      sharedSegment(
        episode(seconds(600), jingle, seconds(12), 5),
        episode(seconds(600), jingle, seconds(37), 6),
        HOP,
      ),
    ).toBeUndefined();
    const same = episode(seconds(600), new Uint32Array(0), 0, 7);
    expect(sharedSegment(same, same.slice(), HOP)).toBeUndefined();
  });

  it('joins the tune when dialogue keeps breaking into it', () => {
    // In the second episode, 2.5 s of every 5 s of the tune is under talk.
    const talked = Uint32Array.from(tune);
    const noise = random(9);
    for (let i = 0; i < talked.length; i++) {
      if ((i * HOP) % 5 >= 2.5) talked[i] = noise();
    }
    const a = episode(seconds(600), tune, seconds(70), 11);
    const b = episode(seconds(600), talked, seconds(30), 12);
    const segment = sharedSegment(a, b, HOP);
    expect(segment?.start).toBeCloseTo(70, 0);
    expect(segment?.end).toBeGreaterThan(112);
    expect(segment?.otherStart).toBeCloseTo(30, 0);
  });

  it('still finds the tune when the episodes share a longer scene elsewhere', () => {
    // The second episode replays 200 s of the first (too long for an intro).
    const scene = Uint32Array.from({ length: seconds(200) }, random(21));
    const a = episode(seconds(600), tune, seconds(20), 13);
    scene.forEach((value, i) => {
      a[seconds(300) + i] = value;
    });
    const b = episode(seconds(600), tune, seconds(90), 14);
    scene.forEach((value, i) => {
      b[seconds(150) + i] = value;
    });
    const segment = sharedSegment(a, b, HOP);
    expect(segment?.start).toBeCloseTo(20, 0);
    expect(segment?.end).toBeCloseTo(65, 0);
    expect(segment?.otherStart).toBeCloseTo(90, 0);
  });

  it('gives every shared part, and picks the one most episodes have', () => {
    const scene = Uint32Array.from({ length: seconds(60) }, random(31));
    const a = episode(seconds(600), tune, seconds(100), 15);
    scene.forEach((value, i) => {
      a[seconds(10) + i] = value;
    });
    const b = episode(seconds(600), scene, seconds(400), 16);
    tune.forEach((value, i) => {
      b[seconds(50) + i] = value;
    });
    const parts = sharedSegments(a, b, HOP);
    expect(parts.map((p) => Math.round(p.start))).toEqual([10, 100]);
    const intro = parts[1] as (typeof parts)[number];
    const other = sharedSegments(a, episode(seconds(600), tune, seconds(5), 17), HOP);
    expect(pickShared([parts, other])).toEqual({ start: intro.start, end: intro.end, agree: 2 });
    expect(pickShared([parts])?.start).toBeCloseTo(10, 0);
    expect(pickShared([])).toBeUndefined();
  });

  it('decodes base64 frames', () => {
    const frames = Uint32Array.from([0, 1, 0xffffffff, 123456789]);
    expect(Array.from(decodeFrames(encode(frames)))).toEqual(Array.from(frames));
  });

  it('takes the intro most episodes agree on', () => {
    const intro = { start: 60, end: 150, otherStart: 0 };
    const song = { start: 300, end: 420, otherStart: 0 };
    expect(pickIntro([song, intro, { ...intro, start: 61 }])).toEqual({ start: 60, end: 150 });
    expect(pickIntro([intro])).toEqual({ start: 60, end: 150 });
    expect(pickIntro([])).toBeUndefined();
  });

  it('knows intro chapters by name', () => {
    expect(
      introChapter([
        { start: 0, end: 90, title: 'Prologue' },
        { start: 90, end: 180, title: 'Opening' },
      ]),
    ).toEqual({ start: 90, end: 180 });
    expect(introChapter([{ start: 0, end: 30, title: ' Intro ' }])).toEqual({ start: 0, end: 30 });
    expect(introChapter([{ start: 0, end: 600, title: 'Chapter 1' }])).toBeUndefined();
    expect(introChapter([{ start: 0, end: 2, title: 'OP' }])).toBeUndefined();
    expect(introChapter([{ start: 0, end: 90, title: 'OP2' }])).toEqual({ start: 0, end: 90 });
    expect(introChapter([{ start: 0, end: 90, title: 'Opening Song' }])).toEqual({
      start: 0,
      end: 90,
    });
    expect(introChapter([{ start: 0, end: 90, title: 'Operation' }])).toBeUndefined();
  });

  it('knows credits chapters by name, the last one', () => {
    expect(
      creditsChapter([
        { start: 0, end: 1300, title: 'Episode' },
        { start: 1300, end: 1390, title: 'Ending' },
        { start: 1390, end: 1420, title: 'Preview' },
      ]),
    ).toEqual({ start: 1300, end: 1390 });
    expect(creditsChapter([{ start: 1200, end: 1260, title: 'End Credits' }])).toEqual({
      start: 1200,
      end: 1260,
    });
    expect(creditsChapter([{ start: 0, end: 600, title: 'Chapter 1' }])).toBeUndefined();
    expect(creditsChapter([{ start: 1200, end: 1290, title: 'ED 1' }])).toEqual({
      start: 1200,
      end: 1290,
    });
    expect(creditsChapter([{ start: 1200, end: 1290, title: 'Editing' }])).toBeUndefined();
  });

  it('allows a longer shared part for the credits', () => {
    const song = Uint32Array.from({ length: seconds(200) }, random(5));
    const a = episode(seconds(400), song, seconds(100), 1);
    const b = episode(seconds(400), song, seconds(120), 2);
    expect(sharedSegment(a, b, HOP)).toBeUndefined();
    const credits = sharedSegment(a, b, HOP, CREDITS_LIMITS);
    expect(credits?.start).toBeCloseTo(100, 0);
    expect(credits?.end).toBeCloseTo(300, 0);
  });
});

// --- Real audio ---------------------------------------------------------------------

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const transcoderSrc = fileURLToPath(
  new URL('../../transcoder/src/fingerprint.ts', import.meta.url),
);

describe.skipIf(!hasFfmpeg)('real audio (FFmpeg and the transcoder fingerprint)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-intro-'));
    const tuneSource =
      "aevalsrc='0.4*sin(2*PI*(220+55*mod(floor(t*2),7))*t)+0.2*sin(2*PI*(660+40*mod(floor(t*3),5))*t)':s=44100:d=40";
    const make = (name: string, before: number, seed: number, codec: string[]) =>
      // prettier-ignore
      execFileSync('ffmpeg', [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `anoisesrc=d=${before}:c=pink:seed=${seed}:a=0.3:r=44100`,
        '-f', 'lavfi', '-i', tuneSource,
        '-f', 'lavfi', '-i', `anoisesrc=d=60:c=brown:seed=${seed + 100}:a=0.3:r=44100`,
        '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[a]', '-map', '[a]',
        ...codec, path.join(dir, name),
      ]);
    make('E1.mkv', 8, 1, ['-c:a', 'aac', '-b:a', '128k']);
    make('E2.mkv', 31, 2, ['-c:a', 'libopus', '-b:a', '96k']);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the shared tune where it is', () => {
    // The transcoder's code, run by Node itself (it is TypeScript with .ts imports).
    const script = `
      import { FingerprintJobs } from ${JSON.stringify(transcoderSrc)};
      const jobs = new FingerprintJobs({ mediaRoot: ${JSON.stringify(dir)}, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, { info() {}, error() {} });
      const out = {};
      for (const name of ['E1.mkv', 'E2.mkv']) {
        const fp = await jobs.fingerprint({ path: name, seconds: 100 });
        const buffer = Buffer.alloc(fp.frames.length * 4);
        fp.frames.forEach((v, i) => buffer.writeUInt32LE(v, i * 4));
        out[name] = { hop: fp.hop, frames: buffer.toString('base64') };
      }
      console.log(JSON.stringify(out));
    `;
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    const prints = JSON.parse(output) as Record<string, { hop: number; frames: string }>;
    const a = prints['E1.mkv'];
    const b = prints['E2.mkv'];
    if (!a || !b) throw new Error('no fingerprints');
    const segment = sharedSegment(decodeFrames(a.frames), decodeFrames(b.frames), a.hop);
    expect(segment).toBeDefined();
    expect(segment?.start).toBeGreaterThan(6);
    expect(segment?.start).toBeLessThan(11);
    expect(segment?.end).toBeGreaterThan(44);
    expect(segment?.end).toBeLessThan(51);
    expect(segment?.otherStart).toBeGreaterThan(29);
    expect(segment?.otherStart).toBeLessThan(34);
  });
});

// --- The search and the routes ----------------------------------------------------------

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('intro search (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let intro: IntroService;
  let cache: string;
  let now = 1_000_000;
  const files: Record<string, string> = {};
  const fingerprinted: string[] = [];

  // Episode n has the tune at 20 s + 10·n; episode 4 has chapters instead.
  const prints: Record<string, { frames: Uint32Array; chapters: unknown[] }> = {};
  // The end (the last 600 s of 1500, from 900 s): the closing song at 900 + 250 + 5·n s,
  // after it a preview; episode 4 has an "Ending" chapter, episode 5 no song.
  const endPrints: Record<string, { frames: Uint32Array; chapters: unknown[] }> = {};

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "Subtitle", "WatchProgress", "User", "Session" CASCADE',
    );
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-intro-cache-'));
    const transcoder = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: (async (input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          path: string;
          start?: number;
          readrate?: number;
          times?: number[];
        };
        if (String(input).endsWith('/frames')) {
          // The film: a scene to the end, no credits to see.
          const scene = { dark: 0.2, mid: 0.5, bright: 0.3, rows: 180, perRow: 100 };
          return Response.json({
            samples: (body.times ?? []).map((t) => ({ time: t, at: t, ...scene })),
          });
        }
        fingerprinted.push(body.start ? `${body.path} @${body.start}` : body.path);
        const print = (body.start ? endPrints : prints)[body.path];
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
    intro = new IntroService({
      prisma,
      transcoder,
      cacheDir: cache,
      now: () => now,
      filmPauseMs: 0,
    });

    const library = await prisma.library.create({
      data: { name: 'Series', type: 'SHOWS', path: 'Series' },
    });
    const show = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'SHOW',
        path: 'Series/Show',
        title: 'Show',
        sortTitle: 'show',
        metadataStatus: 'MATCHED',
      },
    });
    const season = await prisma.season.create({ data: { mediaItemId: show.id, seasonNumber: 1 } });
    for (const n of [1, 2, 3, 4, 5]) {
      const filePath = `Series/Show/Season 1/Show - S01E0${n}.mkv`;
      const episodeRow = await prisma.episode.create({
        data: { seasonId: season.id, episodeNumber: n, title: `Episode ${n}` },
      });
      const file = await prisma.mediaFile.create({
        data: {
          episodeId: episodeRow.id,
          path: filePath,
          size: BigInt(n),
          modifiedAt: new Date('2026-10-01T00:00:00Z'),
          durationMs: 1_500_000,
          bitrate: 10_000_000,
          audioTracks: [{ index: 1, codec: 'eac3', default: true }],
        },
      });
      files[`E${n}`] = file.id;
      prints[filePath] =
        n === 4
          ? {
              frames: episode(seconds(600), new Uint32Array(0), 0, 40),
              chapters: [
                { start: 0, end: 75, title: 'Cold open' },
                { start: 75, end: 165, title: 'Opening' },
              ],
            }
          : n === 5
            ? { frames: episode(seconds(600), new Uint32Array(0), 0, 50), chapters: [] }
            : { frames: episode(seconds(600), tune, seconds(20 + 10 * n), n), chapters: [] };
      endPrints[filePath] =
        n === 4
          ? {
              frames: episode(seconds(600), new Uint32Array(0), 0, 60),
              chapters: [
                { start: 0, end: 75, title: 'Cold open' },
                { start: 75, end: 165, title: 'Opening' },
                { start: 1360, end: 1450, title: 'Ending' },
              ],
            }
          : n === 5
            ? { frames: episode(seconds(600), new Uint32Array(0), 0, 70), chapters: [] }
            : {
                frames: episode(seconds(600), closing, seconds(250 + 5 * n), n + 20),
                chapters: [],
              };
    }
    const movie = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'MOVIE',
        path: 'Movies/Film',
        title: 'Film',
        sortTitle: 'film',
        metadataStatus: 'MATCHED',
        files: {
          create: {
            path: 'Movies/Film/Film.mkv',
            size: 1n,
            modifiedAt: new Date(),
            durationMs: 7_200_000,
          },
        },
      },
      include: { files: true },
    });
    files.movie = movie.files[0]?.id ?? '';

    const services = {
      prisma,
      scanner: {},
      metadata: {},
      images: {},
      mediaRoot: '/media',
      intro,
    };
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

  it('says an episode is pending, and a film only for its credits', async () => {
    const episodeRes = await app.inject(`/api/files/${files.E1}/intro`);
    expect(episodeRes.json()).toEqual({
      pending: true,
      introPending: true,
      creditsPending: true,
      recapPending: true,
      previewPending: true,
    });
    const filmRes = await app.inject(`/api/files/${files.movie}/intro`);
    expect(filmRes.json()).toEqual({
      pending: true,
      introPending: false,
      creditsPending: true,
      recapPending: false,
      previewPending: false,
    });
    const context = await app.inject(`/api/files/${files.E1}`);
    expect(context.json()).toMatchObject({ introPending: true, creditsPending: true });
  });

  it('finds the intro from the neighbours, and keeps their fingerprints', async () => {
    const info = await intro.analyze(files.E2 ?? '');
    expect(info.source).toBe('audio');
    expect((info.intro?.startMs ?? 0) / 1000).toBeCloseTo(40, 0);
    // Within a gap of the end (random frames next to the tune can match).
    expect(Math.abs((info.intro?.endMs ?? 0) / 1000 - 85)).toBeLessThan(1.5);
    // The credits: where the closing song is, counted from the start of the file.
    expect(info.creditsSource).toBe('audio');
    expect((info.credits?.startMs ?? 0) / 1000).toBeCloseTo(900 + 260, 0);
    expect((info.credits?.endMs ?? 0) / 1000).toBeCloseTo(900 + 340, 0);
    expect(info.pending).toBe(false);
    const before = fingerprinted.length;
    await intro.analyze(files.E3 ?? '');
    // E3's neighbours (E2, E4, E1 …) were all fingerprinted already: only from the
    // cache. New is the middle of E2, for E3's recap (the whole episode before).
    expect(fingerprinted.slice(before)).toEqual([expect.stringMatching(/E02.* @\d+$/)]);
    const e3 = await intro.info(files.E3 ?? '');
    expect((e3.intro?.startMs ?? 0) / 1000).toBeCloseTo(50, 0);
  });

  it('takes an "Opening" chapter, and gives an episode without the tune no intro', async () => {
    const chapter = await intro.analyze(files.E4 ?? '');
    expect(chapter).toEqual({
      intro: { startMs: 75_000, endMs: 165_000 },
      source: 'chapter',
      credits: { startMs: 1_360_000, endMs: 1_450_000 },
      creditsSource: 'chapter',
      confidence: { intro: 0.95, credits: 0.95 },
      pending: false,
      introPending: false,
      creditsPending: false,
      recapPending: false,
      previewPending: false,
    });
    const none = await intro.analyze(files.E5 ?? '');
    expect(none).toEqual({
      pending: false,
      introPending: false,
      creditsPending: false,
      recapPending: false,
      previewPending: false,
    });
  });

  it('gives the player the intro with the file', async () => {
    const context = await app.inject(`/api/files/${files.E2}`);
    const body = context.json() as {
      intro?: { startMs: number };
      introPending?: boolean;
      credits?: { startMs: number };
      creditsPending?: boolean;
    };
    expect(body.intro?.startMs).toBeGreaterThan(39_000);
    expect(body.introPending).toBeUndefined();
    expect(body.credits?.startMs).toBeGreaterThan(1_150_000);
    expect(body.creditsPending).toBeUndefined();
  });

  it('lets an admin set, clear and redo the intro, and the search keeps hands off', async () => {
    const set = await app.inject({
      method: 'PUT',
      url: `/api/files/${files.E2}/intro`,
      payload: { startMs: 30_000, endMs: 95_000 },
    });
    expect(set.json()).toMatchObject({
      intro: { startMs: 30_000, endMs: 95_000 },
      source: 'manual',
      pending: false,
    });
    await intro.analyze(files.E2 ?? '');
    expect((await intro.info(files.E2 ?? '')).intro).toEqual({ startMs: 30_000, endMs: 95_000 });

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/files/${files.E2}/intro`,
      payload: { startMs: 30_000, endMs: 20_000 },
    });
    expect(bad.statusCode).toBe(400);

    const cleared = await app.inject({ method: 'DELETE', url: `/api/files/${files.E2}/intro` });
    expect(cleared.json()).toMatchObject({ source: 'manual', pending: false });
    expect(cleared.json().intro).toBeUndefined();

    const redo = await app.inject({ method: 'POST', url: `/api/files/${files.E2}/intro/detect` });
    expect(redo.statusCode).toBe(202);
    expect(redo.json()).toMatchObject({ pending: true, introPending: true, creditsPending: false });
  });

  it('lets an admin set and clear the credits, and counts them as watched', async () => {
    const set = await app.inject({
      method: 'PUT',
      url: `/api/files/${files.E3}/credits`,
      payload: { startMs: 1_300_000, endMs: 1_500_000 },
    });
    expect(set.json()).toMatchObject({
      credits: { startMs: 1_300_000, endMs: 1_500_000 },
      creditsSource: 'manual',
    });
    await intro.analyze(files.E3 ?? '');
    expect((await intro.info(files.E3 ?? '')).credits?.startMs).toBe(1_300_000);

    // Stopping at the credits is watched (not only in the last 8% or 2 minutes).
    const user = await prisma.user.upsert({
      where: { username: 'kijker' },
      create: { username: 'kijker', displayName: 'Kijker', passwordHash: 'x' },
      update: {},
    });
    const { reportProgress } = await import('../src/progress.js');
    await reportProgress(prisma, user.id, files.E3 ?? '', 1_290_000);
    expect((await reportProgress(prisma, user.id, files.E3 ?? '', 1_298_000))?.watched).toBe(true);

    const cleared = await app.inject({ method: 'DELETE', url: `/api/files/${files.E3}/credits` });
    expect(cleared.json()).toMatchObject({ creditsSource: 'manual', creditsPending: false });
    expect(cleared.json().credits).toBeUndefined();
    const redo = await app.inject({ method: 'POST', url: `/api/files/${files.E3}/credits/detect` });
    expect(redo.json()).toMatchObject({ creditsPending: true });
  });

  it('waits for a transcoder that cannot read from a point (too old)', async () => {
    const old = new IntroService({
      prisma,
      transcoder: new TranscoderClient({
        url: 'http://transcoder',
        token: 'secret-token-1234567890',
        fetch: (async () =>
          Response.json({
            hop: HOP,
            count: 0,
            frames: '',
            chapters: [],
          })) as unknown as typeof fetch,
      }),
      now: () => now,
    });
    await old.prioritize(files.E3 ?? '');
    expect(await old.runOnce()).toBe(false);
    expect((await old.status()).waiting).toBe('transcoder');
    expect((await old.info(files.E3 ?? '')).creditsPending).toBe(true);
  });

  it('runs the queue: an opened episode first, and the rest only while nobody watches', async () => {
    await prisma.mediaFile.updateMany({
      data: {
        introCheckedAt: null,
        introSource: null,
        creditsCheckedAt: null,
        creditsSource: null,
      },
    });
    intro.activity.touch();
    await intro.prioritize(files.E1 ?? '');
    expect(await intro.runOnce()).toBe(true);
    expect((await intro.info(files.E1 ?? '')).pending).toBe(false);
    // E2, E3 … of the same season came along in the queue.
    expect(await intro.runOnce()).toBe(true);
    expect((await intro.info(files.E2 ?? '')).pending).toBe(false);
    // The rest of the queue (also the film opened before), then nothing while someone watches.
    while (await intro.runOnce());
    // Someone watches: the background waits.
    await prisma.mediaFile.updateMany({
      data: {
        introCheckedAt: null,
        introSource: null,
        creditsCheckedAt: null,
        creditsSource: null,
      },
    });
    expect(await intro.runOnce()).toBe(false);
    expect((await intro.status()).waiting).toBe('playback');
    now += 3 * 60_000;
    // What came in last goes first, not the first path.
    await prisma.mediaFile.update({
      where: { id: files.E3 ?? '' },
      data: { addedAt: new Date('2030-01-01T00:00:00Z') },
    });
    expect(await intro.runOnce()).toBe(true);
    // The intro and the credits; the recap and the preview come in the second round.
    expect(await intro.info(files.E3 ?? '')).toMatchObject({
      introPending: false,
      creditsPending: false,
    });
    expect((await intro.info(files.E1 ?? '')).pending).toBe(true);
    const status = await app.inject('/api/intro/status');
    expect(status.json()).toMatchObject({ episodes: 5, checked: 1, creditsChecked: 1 });
  });

  it('looks at what a scan brought in right away, also while someone watches', async () => {
    // Everything was looked at; someone watches.
    while (await intro.runOnce());
    await prisma.mediaFile.updateMany({
      data: { introCheckedAt: new Date(now), creditsCheckedAt: new Date(now) },
    });
    intro.activity.touch();
    expect(await intro.runOnce()).toBe(false);
    // Sonarr brings in a new version of E2 (the scan probes it again: open again).
    const startedAt = new Date(now - 1000);
    await prisma.mediaFile.update({
      where: { id: files.E2 ?? '' },
      data: { introCheckedAt: null, creditsCheckedAt: null, probedAt: new Date(now) },
    });
    const show = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: files.E2 ?? '' },
      select: { episode: { select: { season: { select: { mediaItem: true } } } } },
    });
    const libraryId = show.episode?.season.mediaItem.libraryId ?? '';
    expect(await intro.scanned({ libraryId, startedAt })).toBe(1);
    // Not left for when nobody watches any more.
    expect(await intro.runOnce()).toBe(true);
    expect((await intro.info(files.E2 ?? '')).pending).toBe(false);
    // A later scan that brought nothing in queues nothing (createdAt is the database's own clock).
    expect(await intro.scanned({ libraryId, startedAt: new Date(Date.now() + 60_000) })).toBe(0);
  });

  it('marks watching from stream requests', async () => {
    now += 10 * 60_000;
    await app.inject(`/api/files/${files.E1}/stream`);
    expect(intro.activity.idle(60_000)).toBe(false);
  });
});
