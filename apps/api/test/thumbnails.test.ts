// Timeline previews: sheets from a fake transcoder, against PostgreSQL.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { layoutFor, ThumbnailService } from '../src/thumbnails.js';
import { TranscoderClient } from '../src/transcoder.js';
import { TEST_AUTH } from './auth-helpers.js';

describe('layoutFor', () => {
  const file = {
    id: 'f',
    path: 'x.mkv',
    size: 1n,
    modifiedAt: new Date(0),
    width: 3840,
    height: 1600,
    durationMs: 1_400_000,
    hdrFormat: null,
  };
  it('takes a picture every 10 s, fewer for long films, in the video shape', () => {
    expect(layoutFor(file)).toMatchObject({ interval: 10, width: 320, height: 134, count: 140 });
    expect(layoutFor(file)?.sheets).toBe(6);
    // A film of 2.5 hours: about 400 pictures.
    expect(layoutFor({ ...file, durationMs: 9_000_000 })).toMatchObject({
      interval: 23,
      count: 392,
    });
    expect(layoutFor({ ...file, durationMs: 60_000 })).toBeUndefined();
    expect(layoutFor({ ...file, width: null })).toBeUndefined();
    // Another file version, another folder.
    expect(layoutFor({ ...file, size: 2n })?.version).not.toBe(layoutFor(file)?.version);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('timeline previews (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let thumbnails: ThumbnailService;
  let cache: string;
  let idle = true;
  let down = false;
  const calls: { path: string; times: number[]; width: number; height: number; hdr?: boolean }[] =
    [];
  const files: Record<string, string> = {};
  const script = { headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` } };

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "User", "Session" CASCADE',
    );
    cache = mkdtempSync(path.join(tmpdir(), 'cinevault-thumbs-'));
    const transcoder = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: (async (_input: string, init: RequestInit) => {
        if (down) throw new TypeError('fetch failed');
        const body = JSON.parse(String(init.body)) as (typeof calls)[number];
        calls.push(body);
        if (body.path.includes('broken')) {
          return Response.json({ error: 'ffmpeg could not read pictures' }, { status: 422 });
        }
        // Someone starts watching after the first sheet.
        if (body.path.includes('Long') && body.times[0] === 0) idle = false;
        return new Response(`JPEG ${body.path} ${body.times[0]}`, {
          headers: { 'content-type': 'image/jpeg' },
        });
      }) as typeof fetch,
    });
    thumbnails = new ThumbnailService({ prisma, cacheDir: cache, transcoder, idle: () => idle });

    const library = await prisma.library.create({
      data: { name: 'Movies', type: 'MOVIES', path: 'Movies' },
    });
    const movie = async (name: string, durationMs: number, extra: object = {}) => {
      const item = await prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          type: 'MOVIE',
          path: `Movies/${name}`,
          title: name,
          sortTitle: name.toLowerCase(),
          files: {
            create: {
              path: `Movies/${name}/${name}.mkv`,
              size: 1000n,
              modifiedAt: new Date('2026-10-01T00:00:00Z'),
              width: 1920,
              height: 1080,
              durationMs,
              ...extra,
            },
          },
        },
        include: { files: true },
      });
      files[name] = item.files[0]?.id ?? '';
    };
    // Newest first: Long, then Short, then broken.
    await movie('broken', 600_000, { addedAt: new Date('2026-10-01') });
    await movie('Short', 240_000, { addedAt: new Date('2026-10-02'), hdrFormat: 'HDR10' });
    await movie('Long', 1_200_000, { addedAt: new Date('2026-10-03') });
    await movie('Clip', 30_000, { addedAt: new Date('2026-10-04') });

    app = await buildApp({
      checkDatabase: async () => {},
      services: {
        prisma,
        scanner: {},
        metadata: {},
        images: {},
        mediaRoot: '/media',
        thumbnails,
      } as unknown as AppServices,
      auth: TEST_AUTH,
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    rmSync(cache, { recursive: true, force: true });
  });

  const info = async (name: string) =>
    (await app.inject({ url: `/api/files/${files[name]}/thumbnails`, ...script })).json();

  it('makes sheets while nobody watches, and goes on where it stopped', async () => {
    expect(await info('Long')).toEqual({ pending: true });
    expect(await info('Clip')).toEqual({ pending: false });

    // Long: 120 pictures in 5 sheets; someone watches after the first.
    expect(await thumbnails.runOnce()).toBe(0);
    expect(calls.map((c) => [c.path, c.times[0], c.times.length])).toEqual([
      ['Movies/Long/Long.mkv', 0, 25],
    ]);
    expect(calls[0]).toMatchObject({ width: 320, height: 180 });
    expect(calls[0]?.times.slice(0, 3)).toEqual([0, 10, 20]);
    expect(await info('Long')).toEqual({ pending: true });

    idle = true;
    calls.length = 0;
    expect(await thumbnails.runOnce()).toBe(2);
    // Long from its second sheet, then Short (HDR), then broken (unreadable).
    expect(calls.map((c) => [c.path, c.times[0]])).toEqual([
      ['Movies/Long/Long.mkv', 250],
      ['Movies/Long/Long.mkv', 500],
      ['Movies/Long/Long.mkv', 750],
      ['Movies/Long/Long.mkv', 1000],
      ['Movies/Short/Short.mkv', 0],
      ['Movies/broken/broken.mkv', 0],
    ]);
    expect(calls[3]?.times.length).toBe(20);
    expect(calls[4]).toMatchObject({ hdr: true });

    const long = await info('Long');
    expect(long.pending).toBe(false);
    expect(long.thumbnails).toMatchObject({
      interval: 10,
      width: 320,
      height: 180,
      columns: 5,
      rows: 5,
      count: 120,
    });
    expect(long.thumbnails.sheets).toHaveLength(5);
    const sheet = await app.inject({ url: long.thumbnails.sheets[2], ...script });
    expect(sheet.statusCode).toBe(200);
    expect(sheet.headers['content-type']).toBe('image/jpeg');
    expect(sheet.headers['cache-control']).toContain('immutable');
    expect(sheet.body).toBe('JPEG Movies/Long/Long.mkv 500');
    expect((await app.inject({ url: `${long.thumbnails.sheets[2]}x`, ...script })).statusCode).toBe(
      400,
    );
    expect(await info('broken')).toEqual({ pending: false });

    // Nothing left: no more calls.
    calls.length = 0;
    expect(await thumbnails.runOnce()).toBe(0);
    expect(calls).toEqual([]);
  });

  it('makes them anew for a new file version and forgets the old ones', async () => {
    const before = readdirSync(path.join(cache, 'thumbnails', files.Short ?? ''));
    await prisma.mediaFile.update({ where: { id: files.Short }, data: { size: 2000n } });
    calls.length = 0;
    expect(await thumbnails.runOnce()).toBe(1);
    expect(calls.map((c) => c.path)).toEqual(['Movies/Short/Short.mkv']);
    const after = readdirSync(path.join(cache, 'thumbnails', files.Short ?? ''));
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);

    // A file that is gone loses its pictures.
    await prisma.mediaFile.delete({ where: { id: files.Short } });
    await thumbnails.runOnce();
    expect(existsSync(path.join(cache, 'thumbnails', files.Short ?? ''))).toBe(false);
    expect(existsSync(path.join(cache, 'thumbnails', files.Long ?? ''))).toBe(true);
  });

  it('waits when the transcoder is away', async () => {
    await prisma.mediaFile.update({ where: { id: files.Long }, data: { size: 3000n } });
    down = true;
    calls.length = 0;
    expect(await thumbnails.runOnce()).toBe(0);
    down = false;
    // Paused for a while: no new attempt right away.
    expect(await thumbnails.runOnce()).toBe(0);
    expect(calls).toEqual([]);
    expect(await info('Long')).toEqual({ pending: true });
  });
});
