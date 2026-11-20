// Skip markers: how sure the search is of each part (and the players not
// getting the unsure ones), the preview of the next episode, what a profile
// skips by itself, and a season in Beheer (copy an intro, look again).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { pickPreview, previewChapter, scoreRecap, sharedConfidence } from '../src/intro/match.js';
import { IntroService } from '../src/intro/service.js';
import { TranscoderClient } from '../src/transcoder.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
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
  const next = random(Math.round(at * 1000 + fromAt));
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

describe('how sure, and the preview', () => {
  it('is as sure of an intro as the share of episodes that have it', () => {
    expect(sharedConfidence(3, 3)).toBe(1);
    expect(sharedConfidence(1, 3)).toBeCloseTo(0.33, 2);
    // One other episode is never enough for more than a half.
    expect(sharedConfidence(2, 1)).toBe(1);
    expect(sharedConfidence(1, 1)).toBe(0.5);
  });

  it('is surer of a recap from many places', () => {
    const clip = (start: number, other: number) => ({
      start,
      end: start + 9,
      otherStart: other,
    });
    const many = scoreRecap({ clips: [clip(1, 100), clip(12, 400), clip(23, 700)] });
    expect(many?.confidence).toBeGreaterThan(0.8);
    const one = scoreRecap({ clips: [{ start: 2, end: 40, otherStart: 500 }] });
    expect(one?.confidence).toBe(0.5);
  });

  it('finds the preview after the credits, not the scene the next one replays', () => {
    const credits = { start: 1300, end: 1380 };
    const preview = [
      { start: 1385, end: 1393, otherStart: 300 },
      { start: 1396, end: 1404, otherStart: 700 },
      { start: 1407, end: 1415, otherStart: 1100 },
    ];
    expect(pickPreview({ clips: preview, duration: 1420, credits })).toEqual({
      start: 1385,
      end: 1420,
      confidence: 0.8,
    });
    // The last scene before the credits, in the next one's recap: no preview.
    const cliffhanger = [
      { start: 1270, end: 1280, otherStart: 5 },
      { start: 1283, end: 1293, otherStart: 17 },
    ];
    expect(
      pickPreview({
        clips: cliffhanger,
        duration: 1420,
        credits,
        nextIntro: { start: 60, end: 150 },
      }),
    ).toBeUndefined();
    // The next one's intro (a song both play) is no preview either.
    expect(
      pickPreview({
        clips: preview.map((c) => ({ ...c, otherStart: 70 + (c.start - 1385) })),
        duration: 1420,
        credits,
        nextIntro: { start: 60, end: 150 },
      }),
    ).toBeUndefined();
  });

  it('knows preview chapters by name', () => {
    expect(
      previewChapter([
        { start: 0, end: 1300, title: 'Episode' },
        { start: 1390, end: 1420, title: 'Next Episode' },
      ]),
    ).toEqual({ start: 1390, end: 1420 });
    expect(previewChapter([{ start: 1390, end: 1420, title: 'Yokoku' }])).toBeDefined();
    expect(previewChapter([{ start: 0, end: 1300, title: 'Previously' }])).toBeUndefined();
  });
});

describe.skipIf(!databaseUrl)('skip markers (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let intro: IntroService;
  let cache: string;
  let season = '';
  const files: Record<string, string> = {};
  const prints: Record<string, Uint32Array> = {};
  const endPrints: Record<string, Uint32Array> = {};
  let admin = { cookie: '' };
  let member = { cookie: '' };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "User", "Session" CASCADE',
    );
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-markers-cache-'));
    const transcoder = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: (async (input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { path: string; start?: number };
        if (String(input).endsWith('/frames')) {
          return Response.json({ samples: [] });
        }
        const print = (body.start ? endPrints : prints)[body.path];
        if (!print || (body.start && body.start !== 900)) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }
        return Response.json({
          hop: HOP,
          count: print.length,
          frames: encode(print),
          chapters: [],
          start: body.start ?? 0,
        });
      }) as typeof fetch,
    });
    intro = new IntroService({ prisma, transcoder, cacheDir: cache, filmPauseMs: 0 });

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
    season = (await prisma.season.create({ data: { mediaItemId: show.id, seasonNumber: 1 } })).id;
    const tune = noise(45, 3);
    const closing = noise(80, 4);
    // Episodes of 1500 s: the tune at 30 + 10·n s, the closing song from 1150 s;
    // after it (from 1235 s) a preview of the next episode: three clips of it.
    for (const n of [1, 2, 3]) {
      const filePath = `Series/Show/S01E0${n}.mkv`;
      const start = noise(600, 10 + n);
      paste(start, tune, 0, 45, 30 + 10 * n);
      prints[filePath] = start;
    }
    for (const n of [1, 2, 3]) {
      const filePath = `Series/Show/S01E0${n}.mkv`;
      const end = noise(600, 20 + n);
      paste(end, closing, 0, 80, 250);
      const next = prints[`Series/Show/S01E0${n + 1}.mkv`];
      if (next) {
        paste(end, next, 200, 9, 335);
        paste(end, next, 300, 9, 347);
        paste(end, next, 450, 9, 359);
      }
      endPrints[filePath] = end;
      const episode = await prisma.episode.create({
        data: { seasonId: season, episodeNumber: n, title: `Episode ${n}` },
      });
      files[`E${n}`] = (
        await prisma.mediaFile.create({
          data: {
            episodeId: episode.id,
            path: filePath,
            size: BigInt(n),
            modifiedAt: new Date('2026-10-01T00:00:00Z'),
            durationMs: 1_500_000,
            audioTracks: [{ index: 1, codec: 'aac', default: true }],
          },
        })
      ).id;
    }

    app = await buildApp({
      checkDatabase: async () => {},
      services: {
        prisma,
        scanner: {},
        metadata: {},
        images: {},
        mediaRoot: '/media',
        intro,
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
      payload: { displayName: 'Lid', username: 'lid', password: 'nog-een-wachtwoord' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'lid', password: 'nog-een-wachtwoord' },
    });
    member = { cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' };
  });

  afterAll(async () => {
    intro?.stop();
    await app?.close();
    await prisma?.$disconnect();
    rmSync(cache, { recursive: true, force: true });
  });

  it('finds the intro with how sure it is, and the preview of the next episode', async () => {
    // The first round: the starts and ends of all three (in the cache).
    for (const n of [1, 2, 3]) await intro.analyze(files[`E${n}`] ?? '', false, { recap: 'after' });
    const first = await intro.analyze(files.E1 ?? '');
    expect(first.source).toBe('audio');
    expect(first.confidence?.intro).toBe(1);
    expect(first.confidence?.credits).toBe(1);
    expect((first.preview?.startMs ?? 0) / 1000).toBeCloseTo(1235, 0);
    expect((first.preview?.endMs ?? 0) / 1000).toBeCloseTo(1268, 0);
    expect(first.previewSource).toBe('audio');
    expect(first.confidence?.preview).toBe(0.8);
    // The last episode has no next one: no preview.
    const last = await intro.analyze(files.E3 ?? '');
    expect(last.preview).toBeUndefined();
    expect(last.previewPending).toBe(false);
  });

  it('ends the credits where the preview starts', async () => {
    await prisma.mediaFile.update({
      where: { id: files.E2 ?? '' },
      data: {
        creditsStartMs: 1_150_000,
        creditsEndMs: 1_300_000,
        creditsSource: 'audio',
        previewCheckedAt: null,
      },
    });
    const info = await intro.analyze(files.E2 ?? '');
    expect((info.preview?.startMs ?? 0) / 1000).toBeCloseTo(1235, 0);
    expect(info.credits?.endMs).toBe(info.preview?.startMs);
  });

  it('gives the players no part it is unsure of; an admin sees it', async () => {
    await prisma.mediaFile.update({
      where: { id: files.E1 ?? '' },
      data: { introConfidence: 0.3 },
    });
    const context = await app.inject({ url: `/api/files/${files.E1}`, ...as(member) });
    expect(context.json().intro).toBeUndefined();
    expect(context.json().credits).toBeDefined();
    const player = await app.inject({ url: `/api/files/${files.E1}/intro`, ...as(member) });
    expect(player.json()).toMatchObject({ hidden: ['intro'], confidence: { intro: 0.3 } });
    expect(player.json().intro).toBeUndefined();
    // A member asking for everything still gets what the players get.
    const memberAll = await app.inject({
      url: `/api/files/${files.E1}/intro?all=1`,
      ...as(member),
    });
    expect(memberAll.json().intro).toBeUndefined();
    const all = await app.inject({ url: `/api/files/${files.E1}/intro?all=1`, ...as(admin) });
    expect(all.json().intro).toBeDefined();
    expect(all.json().hidden).toBeUndefined();
  });

  it('keeps what a profile skips by itself, and gives it with the file', async () => {
    const empty = await app.inject({ url: '/api/skip-settings', ...as(member) });
    expect(empty.json()).toEqual({ intro: false, recap: false, credits: false, preview: false });
    const set = await app.inject({
      method: 'PUT',
      url: '/api/skip-settings',
      ...as(member),
      payload: { intro: true, preview: true },
    });
    expect(set.json()).toEqual({ intro: true, recap: false, credits: false, preview: true });
    const context = await app.inject({ url: `/api/files/${files.E2}`, ...as(member) });
    expect(context.json().skip).toEqual({
      intro: true,
      recap: false,
      credits: false,
      preview: true,
    });
    // Per profile: the admin's are their own.
    const other = await app.inject({ url: '/api/skip-settings', ...as(admin) });
    expect(other.json().intro).toBe(false);
    // Not for the scripts' token.
    const script = await app.inject({
      method: 'PUT',
      url: '/api/skip-settings',
      headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` },
      payload: { intro: true },
    });
    expect(script.statusCode).toBe(400);
  });

  it('shows a season in Beheer, copies an intro to all, and looks at it all again', async () => {
    const forbidden = await app.inject({
      url: `/api/admin/seasons/${season}/markers`,
      ...as(member),
    });
    expect(forbidden.statusCode).toBe(403);
    const markers = await app.inject({ url: `/api/admin/seasons/${season}/markers`, ...as(admin) });
    const body = markers.json<import('@cinevault/shared').SeasonMarkers>();
    expect(body.episodes.map((e) => e.episodeNumber)).toEqual([1, 2, 3]);
    // The unsure intro of E1 is there, with how sure it is.
    expect(body.episodes[0]?.markers.intro).toMatchObject({ source: 'audio', confidence: 0.3 });
    expect(body.episodes[0]?.markers.preview).toMatchObject({ source: 'audio' });

    await app.inject({
      method: 'PUT',
      url: `/api/files/${files.E2}/intro`,
      ...as(admin),
      payload: { startMs: 50_000, endMs: 95_000 },
    });
    const copied = await app.inject({
      method: 'POST',
      url: `/api/admin/seasons/${season}/markers/copy`,
      ...as(admin),
      payload: { fileId: files.E2, kind: 'intro' },
    });
    expect(copied.statusCode).toBe(200);
    const after = copied.json<import('@cinevault/shared').SeasonMarkers>();
    for (const episode of after.episodes) {
      expect(episode.markers.intro).toEqual({ startMs: 50_000, endMs: 95_000, source: 'manual' });
    }

    const again = await app.inject({
      method: 'POST',
      url: `/api/admin/seasons/${season}/markers/detect`,
      ...as(admin),
      payload: {},
    });
    expect(again.statusCode).toBe(202);
    const pending = again.json<import('@cinevault/shared').SeasonMarkers>();
    // Not the intros set by hand; the rest is looked at again.
    for (const episode of pending.episodes) {
      expect(episode.pending).not.toContain('intro');
      expect(episode.pending).toContain('credits');
    }
    while (await intro.runOnce());
    const done = await intro.seasonMarkers(season);
    expect(done?.episodes.every((e) => e.pending.length === 0)).toBe(true);
    expect(done?.episodes[0]?.markers.intro?.source).toBe('manual');
    expect(done?.episodes[0]?.markers.credits?.source).toBe('audio');
  });
});
