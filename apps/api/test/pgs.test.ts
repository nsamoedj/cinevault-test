// Picture subtitles (PGS) read as text: the .sup reader, Tesseract on drawn
// text, and the whole way from a track in an MKV to a WebVTT (PostgreSQL).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { cleanLine, ocrLanguage, TesseractEngine, toVtt } from '../src/subtitles/ocr.js';
import { decodeRle, readPgs } from '../src/subtitles/pgs.js';
import { SubtitleService } from '../src/subtitles/service.js';
import { encodeRle, textPicture, writeSup } from './pgs-helpers.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('PGS', () => {
  it('decodes run-length coded lines', () => {
    const pixels = new Uint8Array([
      0,
      0,
      1,
      1,
      1,
      2,
      0,
      0,
      ...Array(70).fill(1),
      ...Array(8).fill(0),
    ]);
    const decoded = decodeRle(new Uint8Array(encodeRle(pixels, 86, 1)), 86, 1);
    expect([...decoded]).toEqual([...pixels]);
  });

  it('reads pictures with their times, and leaves the clears out', () => {
    const cue = {
      width: 4,
      height: 2,
      pixels: new Uint8Array([1, 1, 0, 0, 0, 1, 1, 0]),
      x: 100,
      y: 900,
    };
    const sup = writeSup([
      { ...cue, start: 1.5, end: 3 },
      { ...cue, start: 4, end: 6.25 },
    ]);
    const pictures = readPgs(sup);
    expect(pictures.map((p) => [p.start, p.end])).toEqual([
      [1.5, 3],
      [4, 6.25],
    ]);
    // With a white margin of 12 on each side; the white letters become black.
    expect(pictures[0]).toMatchObject({ width: 28, height: 26 });
    const at = (x: number, y: number) => pictures[0]?.data[(y + 12) * 28 + x + 12];
    expect([at(0, 0), at(2, 0), at(1, 1)]).toEqual([0, 255, 0]);
  });

  it('cleans up what Tesseract makes of an I and stray marks', () => {
    expect(cleanLine('| was  here |')).toBe('I was here I');
    expect(cleanLine("| don't know")).toBe("I don't know");
    expect(cleanLine('  ~Hallo_  ')).toBe('Hallo');
    expect(
      toVtt([
        { start: 1, end: 2, text: 'A' },
        { start: 2.1, end: 3, text: 'A' },
        { start: 3600.5, end: 3602, text: 'B' },
      ]),
    ).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nA\n\n01:00:00.500 --> 01:00:02.000\nB\n');
  });

  it('reads English and Dutch PGS tracks only', () => {
    const track = {
      index: 3,
      codec: 'hdmv_pgs_subtitle',
      forced: false,
      default: false,
      textBased: false,
    };
    expect(ocrLanguage({ ...track, language: 'eng' })).toBe('eng');
    expect(ocrLanguage({ ...track, language: 'dut' })).toBe('nld');
    expect(ocrLanguage(track)).toBe('eng');
    expect(ocrLanguage({ ...track, language: 'jpn' })).toBeUndefined();
    expect(ocrLanguage({ ...track, codec: 'dvd_subtitle', language: 'eng' })).toBeUndefined();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!hasFfmpeg)('Tesseract on subtitle pictures', () => {
  let dir: string;
  let engine: TesseractEngine;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-ocr-'));
    engine = new TesseractEngine(dir);
  });
  afterAll(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the text of a PGS picture, in English and in Dutch', async () => {
    const english = readPgs(
      writeSup([{ ...textPicture('Where are you going?'), start: 1, end: 2, x: 500, y: 950 }]),
    );
    expect(cleanLine(await engine.read(english[0]!, 'eng'))).toBe('Where are you going?');
    const dutch = readPgs(
      writeSup([{ ...textPicture('Waar ga je naartoe?'), start: 1, end: 2, x: 500, y: 950 }]),
    );
    expect(cleanLine(await engine.read(dutch[0]!, 'nld'))).toBe('Waar ga je naartoe?');
  }, 60_000);
});

describe.skipIf(!hasFfmpeg || !databaseUrl)('picture subtitles as text (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let dir: string;
  let service: SubtitleService;
  let fileId = '';
  let idle = false;

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "MediaFile", "Subtitle" CASCADE',
    );
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-pgs-'));
    mkdirSync(path.join(dir, 'media/Movies/F'), { recursive: true });
    // A film of 12 s with an English PGS track of two lines (-copyts keeps the
    // subtitles at their own times instead of moving the first to 0).
    const sup = path.join(dir, 'subs.sup');
    writeFileSync(
      sup,
      writeSup([
        { ...textPicture('Hello there.'), start: 1, end: 3, x: 500, y: 950 },
        { ...textPicture('We have to go now.'), start: 5, end: 8, x: 500, y: 950 },
      ]),
    );
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=12',
      '-copyts', '-i', sup, '-map', '0', '-map', '1', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:s', 'copy', '-metadata:s:s:0', 'language=eng',
      path.join(dir, 'media/Movies/F/F (2020).mkv'),
    ]);
    const library = await prisma.library.create({
      data: { name: 'Movies', type: 'MOVIES', path: 'Movies' },
    });
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'MOVIE',
        path: 'Movies/F',
        title: 'F',
        sortTitle: 'f',
        files: {
          create: {
            path: 'Movies/F/F (2020).mkv',
            size: 1n,
            modifiedAt: new Date(),
            subtitleTracks: [
              {
                index: 1,
                codec: 'hdmv_pgs_subtitle',
                language: 'eng',
                forced: false,
                default: false,
                textBased: false,
              },
            ],
          },
        },
      },
      include: { files: true },
    });
    fileId = item.files[0]?.id ?? '';
    service = new SubtitleService({
      prisma,
      mediaRoot: path.join(dir, 'media'),
      cacheDir: path.join(dir, 'cache'),
      ocr: { engine: new TesseractEngine(path.join(dir, 'cache')), idle: () => idle },
    });
  });

  afterAll(async () => {
    await service?.ocr?.stop();
    await prisma?.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('offers to read a PGS track, reads it when picked, and then it is a text subtitle', async () => {
    const before = await service.list(fileId);
    expect(before[0]).toMatchObject({ id: 'embedded:1', supported: false, ocr: 'possible' });

    const asked = await service.readPictures(fileId, 1);
    expect(['queued', 'running']).toContain(asked.ocr);
    await expect
      .poll(async () => (await service.list(fileId))[0]?.ocr, { timeout: 60_000, interval: 200 })
      .toBe('done');
    const after = (await service.list(fileId))[0];
    expect(after).toMatchObject({ supported: true, language: 'eng' });
    const row = await prisma.subtitle.findFirstOrThrow({ where: { mediaFileId: fileId } });
    const vtt = await service.vtt(row.id);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000\nHello there.');
    expect(vtt).toContain('00:00:05.000 --> 00:00:08.000\nWe have to go now.');
  }, 90_000);

  it('reads the next track in the background only while nobody watches', async () => {
    await prisma.subtitle.deleteMany({});
    expect(await service.ocr?.runOnce()).toBe(false);
    idle = true;
    expect(await service.ocr?.runOnce()).toBe(true);
    expect((await service.list(fileId))[0]?.ocr).toBe('done');
    // Nothing left to read.
    expect(await service.ocr?.runOnce()).toBe(false);
  }, 90_000);
});
