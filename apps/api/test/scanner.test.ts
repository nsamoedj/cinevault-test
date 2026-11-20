// Scanner + library routes against a real PostgreSQL.
// Runs only with TEST_DATABASE_URL set (a database it may wipe), e.g.
//   TEST_DATABASE_URL=postgresql://cinevault:devpass@localhost:5432/cinevault_test pnpm test

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { authorize, TEST_AUTH } from './auth-helpers.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { ImageCache } from '../src/images.js';
import { ensureDefaultLibraries } from '../src/libraries.js';
import { MetadataService } from '../src/metadata/service.js';
import type {
  Candidate,
  ExternalIds,
  ItemMetadata,
  MovieProvider,
  SearchQuery,
  SeasonMetadata,
  ShowMetadata,
  ShowProvider,
} from '../src/metadata/types.js';
import type { ProbeResult } from '../src/scanner/probe.js';
import { Scanner } from '../src/scanner/scanner.js';
import { SubtitleService } from '../src/subtitles/service.js';
import type { SubtitleProvider } from '../src/subtitles/types.js';
import { TranscoderClient } from '../src/transcoder.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const item = (
  provider: 'tmdb' | 'tvmaze',
  id: number,
  title: string,
  extra: Partial<ItemMetadata> = {},
) => ({
  provider,
  id,
  title,
  genres: ['Drama'],
  cast: [{ name: 'Someone', character: 'Lead', profileRef: 'tmdb:w185/someone.jpg', order: 0 }],
  ids: { [provider]: id },
  ...extra,
});

const episodes = (season: number, count: number, title = (n: number) => `S${season}E${n}`) =>
  Array.from({ length: count }, (_, i) => ({ season, episode: i + 1, title: title(i + 1) }));

/** Fake TMDB: knows a few titles from the owner's library. */
class FakeTmdb implements MovieProvider, ShowProvider {
  readonly name = 'tmdb' as const;
  /** Ids passed to getMovie/getShow, to see what a scan fetched. */
  fetched: number[] = [];
  async searchMovies(q: SearchQuery): Promise<Candidate[]> {
    if (q.title === 'A Legend')
      return [{ provider: 'tmdb', id: 100, title: 'A Legend', year: 2024 }];
    if (q.title === 'Unknown Film')
      return [{ provider: 'tmdb', id: 101, title: 'Totally Different', year: 1999 }];
    return [];
  }
  async getMovie(id: number): Promise<ItemMetadata | undefined> {
    this.fetched.push(id);
    if (id === 100) {
      return item('tmdb', 100, 'A Legend', {
        year: 2024,
        releaseDate: '2024-05-17',
        overview: 'Legend overview',
        posterRef: 'tmdb:w500/legend.jpg',
        backdropRef: 'tmdb:w1280/legend-bg.jpg',
        ids: { tmdb: 100, imdb: 'tt100' },
      });
    }
    if (id === 101) return item('tmdb', 101, 'Totally Different', { year: 1999 });
    return undefined;
  }
  async findMovie(ids: ExternalIds) {
    return ids.tmdb;
  }
  async searchShows(q: SearchQuery): Promise<Candidate[]> {
    const ids: Record<string, number> = {
      'Agent from Above': 200,
      Bleach: 300,
      Frieren: 400,
      'Fire Force': 500,
    };
    const id = ids[q.title];
    return id ? [{ provider: 'tmdb', id, title: q.title }] : [];
  }
  async getShow(id: number, seasons?: number[]): Promise<ShowMetadata | undefined> {
    this.fetched.push(id);
    const pick = (all: SeasonMetadata[]) =>
      seasons ? all.filter((s) => seasons.includes(s.season)) : all;
    if (id === 200) {
      return {
        ...item('tmdb', 200, 'Agent from Above'),
        seasons: pick([
          { season: 1, episodeCount: 5, episodes: episodes(1, 5, (n) => `Episode ${n} title`) },
        ]),
      };
    }
    if (id === 300) {
      // TMDB numbers Bleach differently: no season 17.
      return {
        ...item('tmdb', 300, 'Bleach', { ids: { tmdb: 300, tvdb: 74796 } }),
        seasons: [{ season: 1, episodeCount: 20, episodes: [] }],
      };
    }
    if (id === 400) {
      return {
        ...item('tmdb', 400, 'Frieren'),
        seasons: pick([
          { season: 1, episodeCount: 10, episodes: episodes(1, 10) },
          { season: 2, episodeCount: 10, episodes: episodes(2, 10) },
        ]),
      };
    }
    if (id === 500) {
      // Known only by its Japanese title, with one English episode title.
      return {
        ...item('tmdb', 500, '炎炎ノ消防隊'),
        seasons: [
          {
            season: 1,
            episodeCount: 2,
            episodes: [
              { season: 1, episode: 1, title: '第1話' },
              { season: 1, episode: 2, title: 'The Heart of a Fire Soldier' },
            ],
          },
        ],
      };
    }
    return undefined;
  }
  async findShow(ids: ExternalIds) {
    return ids.tmdb;
  }
}

class FakeTvmaze implements ShowProvider {
  readonly name = 'tvmaze' as const;
  async searchShows(): Promise<Candidate[]> {
    return [];
  }
  async getShow(id: number): Promise<ShowMetadata | undefined> {
    if (id !== 1000) return undefined;
    return {
      ...item('tvmaze', 1000, 'Bleach'),
      seasons: [
        {
          season: 17,
          episodeCount: 1,
          episodes: [{ season: 17, episode: 1, title: 'The Blood Warfare' }],
        },
      ],
    };
  }
  async findShow(ids: ExternalIds) {
    return ids.tvdb === 74796 ? 1000 : undefined;
  }
}

describe.skipIf(!databaseUrl)('scanner (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let dir: string;
  let media: string;
  let scanner: Scanner;
  let app: FastifyInstance;
  let tmdb: FakeTmdb;
  const probed: string[] = [];
  const transcoderCalls: string[] = [];
  const searches: unknown[] = [];
  const downloads: string[] = [];
  const subtitleDownloads: string[] = [];

  const write = (rel: string, content = 'x') => {
    const file = path.join(media, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  const scanned: { libraryName: string; firstScan: boolean; startedAt: Date }[] = [];

  const probe = async (file: string): Promise<ProbeResult> => {
    probed.push(path.basename(file));
    if (file.includes('Broken')) throw new Error('Invalid data found when processing input');
    return {
      container: 'mkv',
      videoCodec: 'hevc',
      width: 3840,
      height: 2160,
      bitDepth: 10,
      hdrFormat: 'HDR10',
      durationMs: 1_000,
      audioTracks: [{ index: 1, codec: 'eac3', language: 'eng', channels: 6, default: true }],
      subtitleTracks: file.includes('A Legend')
        ? [
            {
              index: 2,
              codec: 'subrip',
              language: 'eng',
              title: 'English',
              forced: false,
              default: false,
              textBased: true,
            },
            {
              index: 3,
              codec: 'hdmv_pgs_subtitle',
              language: 'dut',
              forced: false,
              default: false,
              textBased: false,
            },
          ]
        : [],
    };
  };

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "Subtitle", "WatchProgress", "User" CASCADE',
    );

    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-scan-'));
    media = path.join(dir, 'media');
    write('Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.mkv');
    write('Movies/A Legend (2024)/poster.jpg', 'jpeg');
    write(
      'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.nl.srt',
      '1\n00:00:01,000 --> 00:00:02,000\nHallo\n',
    );
    write('Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.en.forced.srt', '');
    write('Movies/A Legend (2024)/Featurettes/Making Of.mkv');
    write('Movies/Unknown Film (1999)/Unknown Film (1999).mkv');
    write('Movies/Unknown Film (1999)/folder.jpg', 'jpeg');
    write('Movies/Broken (2020)/Broken (2020).mkv');
    // Known content for the range request tests.
    write(
      'Series/Agent from Above/Agent from Above - S01E01 - The Sinner WEBDL-1080p.mkv',
      '0123456789',
    );
    write('Series/Agent from Above/Agent from Above - S01E02 - Karma WEBDL-1080p.mkv');
    write('Anime/Bleach/Season 17/Bleach - S17E01 - THE BLOOD WARFARE WEBDL-2160p.mkv');
    write('Anime/Frieren/[Group] Frieren - 13 [1080p].mkv');
    write(
      'Anime/Fire Force/Season 1/Fire Force - S01E01 - Shinra Kusakabe Enlists WEBDL-1080p.mkv',
    );
    write('Anime/Fire Force/Season 1/Fire Force - S01E02 - Ep Two WEBDL-1080p.mkv');

    const images = new ImageCache({
      cacheDir: path.join(dir, 'cache'),
      mediaRoot: media,
      fetch: (async (input: string | URL | Request) => {
        downloads.push(String(input));
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
          headers: { 'content-type': 'image/jpeg' },
        });
      }) as typeof fetch,
    });
    tmdb = new FakeTmdb();
    const metadata = new MetadataService({ tmdb, tvmaze: new FakeTvmaze() });
    const silent = { info() {}, warn() {}, error() {} };
    scanner = new Scanner({
      prisma,
      mediaRoot: media,
      probe,
      metadata,
      images,
      logger: silent,
      onLibraryScanned: async (scan) => scanned.push(scan),
    });
    // The transcoder reads embedded tracks; here it answers at once with a whole track.
    const transcoder = new TranscoderClient({
      url: 'http://transcoder.test',
      token: 'token-token-token',
      fetch: (async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        transcoderCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { start: number };
          return Response.json(
            { id: '44444444-4444-4444-8444-444444444444', start: body.start },
            { status: 201 },
          );
        }
        return new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEmbedded\n', {
          headers: { 'x-covered': '1.000', 'x-complete': '1' },
        });
      }) as typeof fetch,
    });
    const opensubtitles: SubtitleProvider = {
      name: 'opensubtitles',
      search: async (query) => {
        searches.push(query);
        return [
          {
            id: '555',
            provider: 'opensubtitles',
            language: 'nld',
            release: 'A.Legend.2024.NL',
            downloads: 10,
            hearingImpaired: false,
            matchesFile: true,
            machineTranslated: false,
          },
        ];
      },
      download: async (id) => {
        subtitleDownloads.push(id);
        return {
          bytes: new TextEncoder().encode('1\n00:00:03,000 --> 00:00:04,000\nGedownload\n'),
          fileName: 'A.Legend.2024.NL.srt',
        };
      },
    };
    const subtitles = new SubtitleService({
      prisma,
      mediaRoot: media,
      cacheDir: path.join(dir, 'cache'),
      transcoder,
      opensubtitles,
      wholePollMs: 5,
    });
    app = authorize(
      await buildApp({
        checkDatabase: async () => {},
        services: { prisma, scanner, metadata, images, mediaRoot: media, subtitles },
        auth: TEST_AUTH,
      }),
    );
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const findItem = (title: string) =>
    prisma.mediaItem.findFirstOrThrow({
      where: { title },
      include: {
        files: true,
        seasons: {
          orderBy: { seasonNumber: 'asc' },
          include: { episodes: { orderBy: { episodeNumber: 'asc' }, include: { files: true } } },
        },
      },
    });

  it('creates a library per known folder', async () => {
    expect((await ensureDefaultLibraries(prisma, media)).sort()).toEqual([
      'Anime',
      'Movies',
      'Series',
    ]);
    expect(await ensureDefaultLibraries(prisma, media)).toEqual([]);
    const types = await prisma.library.findMany({
      orderBy: { name: 'asc' },
      select: { name: true, type: true },
    });
    expect(types).toEqual([
      { name: 'Anime', type: 'ANIME' },
      { name: 'Movies', type: 'MOVIES' },
      { name: 'Series', type: 'SHOWS' },
    ]);
  });

  it('scans files, probes them and fetches metadata', async () => {
    // Downloaded long before CineVault's first scan: "added" is the file's date.
    const arrived = new Date('2025-03-04T05:06:07Z');
    const legendFile = path.join(media, 'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.mkv');
    utimesSync(legendFile, arrived, arrived);
    const status = await scanner.scan();

    expect(status).toMatchObject({
      running: false,
      phase: 'done',
      filesFound: 10,
      filesProbed: 8,
      probeErrors: 1,
      filesRemoved: 0,
    });
    expect(probed).not.toContain('Making Of.mkv');

    const legend = await findItem('A Legend');
    expect(legend).toMatchObject({
      type: 'MOVIE',
      path: 'Movies/A Legend (2024)',
      year: 2024,
      releaseDate: new Date('2024-05-17T00:00:00Z'),
      metadataStatus: 'MATCHED',
      metadataProvider: 'tmdb',
      tmdbId: 100,
      imdbId: 'tt100',
      overview: 'Legend overview',
      // The owner's poster.jpg wins over the TMDB poster.
      posterPath: 'media:Movies/A Legend (2024)/poster.jpg',
      backdropPath: 'tmdb:w1280/legend-bg.jpg',
    });
    expect(legend.addedAt).toEqual(arrived);
    expect(legend.files[0]).toMatchObject({
      path: 'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.mkv',
      addedAt: arrived,
      videoCodec: 'hevc',
      hdrFormat: 'HDR10',
      probeError: null,
    });
    expect(downloads).toEqual(['https://image.tmdb.org/t/p/w1280/legend-bg.jpg']);

    expect(await findItem('Unknown Film')).toMatchObject({
      metadataStatus: 'UNMATCHED',
      metadataError: 'no convincing TMDB result',
      // Local artwork shows even without a match.
      posterPath: 'media:Movies/Unknown Film (1999)/folder.jpg',
    });
    expect((await findItem('Broken')).files[0]?.probeError).toMatch(/Invalid data/);

    const agent = await findItem('Agent from Above');
    expect(agent.seasons).toHaveLength(1);
    expect(agent.seasons[0]?.episodes.map((e) => [e.episodeNumber, e.title])).toEqual([
      [1, 'Episode 1 title'],
      [2, 'Episode 2 title'],
    ]);

    const bleach = await findItem('Bleach');
    expect(bleach).toMatchObject({
      metadataProvider: 'tmdb+tvmaze',
      tvmazeId: 1000,
      tvdbId: 74796,
    });
    expect(bleach.seasons[0]).toMatchObject({ seasonNumber: 17 });
    expect(bleach.seasons[0]?.episodes[0]?.title).toBe('The Blood Warfare');

    // Absolute episode 13 = season 2 episode 3 (season 1 has 10 episodes).
    const frieren = await findItem('Frieren');
    expect(frieren.seasons.map((s) => s.seasonNumber)).toEqual([2]);
    expect(frieren.seasons[0]?.episodes[0]).toMatchObject({
      episodeNumber: 3,
      absoluteNumber: 13,
      title: 'S2E3',
    });
    expect(frieren.seasons[0]?.episodes[0]?.files).toHaveLength(1);

    // Titles are English: the folder name and file names stand in for a Japanese title.
    const fireForce = await findItem('Fire Force');
    expect(fireForce).toMatchObject({ metadataStatus: 'MATCHED', sortTitle: 'fire force' });
    expect(fireForce.seasons[0]?.episodes.map((e) => [e.episodeNumber, e.title])).toEqual([
      [1, 'Shinra Kusakabe Enlists'],
      [2, 'The Heart of a Fire Soldier'],
    ]);
  });

  it('keeps subtitle files next to a video as external subtitles', async () => {
    const legend = await findItem('A Legend');
    const subtitles = await prisma.subtitle.findMany({
      where: { mediaFileId: legend.files[0]?.id },
      orderBy: { externalId: 'asc' },
      select: { source: true, language: true, forced: true, externalId: true, path: true },
    });
    const base = 'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p';
    expect(subtitles).toEqual([
      {
        source: 'EXTERNAL',
        language: 'eng',
        forced: true,
        externalId: `${base}.en.forced.srt`,
        path: `media:${base}.en.forced.srt`,
      },
      {
        source: 'EXTERNAL',
        language: 'nld',
        forced: false,
        externalId: `${base}.nl.srt`,
        path: `media:${base}.nl.srt`,
      },
    ]);
  });

  it('does not probe or look up unchanged items again', async () => {
    probed.length = 0;
    // After each library: the first scan says so (no notifications for it).
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned.every((s) => s.firstScan)).toBe(true);
    scanned.length = 0;
    const status = await scanner.scan();
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned.some((s) => s.firstScan)).toBe(false);
    expect(probed).toEqual([]);
    expect(status).toMatchObject({ filesProbed: 0, itemsTotal: 0 });
    // The absolute-numbered file stays where metadata put it.
    const frieren = await findItem('Frieren');
    expect(
      frieren.seasons.map((s) => [s.seasonNumber, s.episodes.map((e) => e.episodeNumber)]),
    ).toEqual([[2, [3]]]);
  });

  it('probes Dolby Vision files once more for the profile, keeping the intro', async () => {
    const legend = await findItem('A Legend');
    const fileId = legend.files[0]?.id ?? '';
    const before = {
      hdrFormat: 'DV',
      dvProfile: null,
      introStartMs: 1_000,
      introEndMs: 30_000,
      introSource: 'audio',
      introCheckedAt: new Date(),
    };
    // Probed before the profile was stored: once more.
    await prisma.mediaFile.update({
      where: { id: fileId },
      data: { ...before, probedAt: new Date('2026-10-01T00:00:00Z') },
    });
    probed.length = 0;
    await scanner.scan();
    expect(probed).toEqual(['A Legend (2024) Bluray-2160p.mkv']);
    expect(await prisma.mediaFile.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
      hdrFormat: 'HDR10',
      introStartMs: 1_000,
      introSource: 'audio',
    });

    // Probed since, and ffprobe can't tell the profile: not again on every scan.
    await prisma.mediaFile.update({ where: { id: fileId }, data: before });
    probed.length = 0;
    await scanner.scan();
    expect(probed).toEqual([]);
    await prisma.mediaFile.update({ where: { id: fileId }, data: { hdrFormat: 'HDR10' } });
  });

  it('forgets a subtitle file that was removed', async () => {
    unlinkSync(
      path.join(media, 'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.en.forced.srt'),
    );
    await scanner.scan();
    const legend = await findItem('A Legend');
    expect(
      (await prisma.subtitle.findMany({ where: { mediaFileId: legend.files[0]?.id } })).map(
        (s) => s.language,
      ),
    ).toEqual(['nld']);
  });

  it('keeps "gezien" when Sonarr upgrades an episode to a file with another name', async () => {
    const dirPath = path.join(media, 'Series/Agent from Above');
    const oldName = 'Agent from Above - S01E02 - Karma WEBDL-1080p.mkv';
    const newName = 'Agent from Above - S01E02 - Karma Bluray-2160p.mkv';
    const before = await prisma.mediaFile.findFirstOrThrow({
      where: { path: `Series/Agent from Above/${oldName}` },
    });
    const viewer = await prisma.user.create({
      data: { username: 'upgrade-viewer', passwordHash: 'x' },
    });
    await prisma.watchProgress.create({
      data: { userId: viewer.id, mediaFileId: before.id, positionMs: 1_000_000, completed: true },
    });

    renameSync(path.join(dirPath, oldName), path.join(dirPath, newName));
    const status = await scanner.scan();
    expect(status.filesRemoved).toBe(1);
    const after = await prisma.mediaFile.findFirstOrThrow({
      where: { path: `Series/Agent from Above/${newName}` },
    });
    expect(after.episodeId).toBe(before.episodeId);
    expect(await prisma.watchProgress.findMany({ where: { userId: viewer.id } })).toEqual([
      expect.objectContaining({ mediaFileId: after.id, positionMs: 1_000_000, completed: true }),
    ]);

    renameSync(path.join(dirPath, newName), path.join(dirPath, oldName));
    await scanner.scan();
    await prisma.user.delete({ where: { id: viewer.id } });
  });

  it('removes deleted files and their empty episodes', async () => {
    unlinkSync(
      path.join(media, 'Series/Agent from Above/Agent from Above - S01E02 - Karma WEBDL-1080p.mkv'),
    );
    const status = await scanner.scan();
    expect(status.filesRemoved).toBe(1);
    const agent = await findItem('Agent from Above');
    expect(agent.seasons[0]?.episodes.map((e) => e.episodeNumber)).toEqual([1]);
  });

  it('falls back to the provider poster when the local one is removed', async () => {
    unlinkSync(path.join(media, 'Movies/A Legend (2024)/poster.jpg'));
    await scanner.scan();
    expect(await findItem('A Legend')).toMatchObject({
      posterPath: 'tmdb:w500/legend.jpg',
      metadataStatus: 'MATCHED',
    });
    write('Movies/A Legend (2024)/poster.jpg', 'jpeg');
    await scanner.scan();
    expect((await findItem('A Legend')).posterPath).toBe('media:Movies/A Legend (2024)/poster.jpg');
  });

  it('keeps everything when a library folder is missing (unplugged disk)', async () => {
    renameSync(path.join(media, 'Series'), path.join(dir, 'Series-away'));
    const status = await scanner.scan();
    renameSync(path.join(dir, 'Series-away'), path.join(media, 'Series'));

    expect(status.filesRemoved).toBe(0);
    expect(status.errors.join('\n')).toMatch(/Series is empty or unavailable; kept 1 known files/);
    expect(await findItem('Agent from Above')).toBeTruthy();
  });

  it('keeps a file it could not read this time (a hiccup, not a deletion)', async () => {
    const file = path.join(media, 'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.mkv');
    const away = path.join(dir, 'legend-away.mkv');
    renameSync(file, away);
    // Listed, but stat fails: as when the bind mount hiccups during a scan.
    symlinkSync(path.join(dir, 'nowhere.mkv'), file);
    const status = await scanner.scan();
    unlinkSync(file);
    renameSync(away, file);

    expect(status.filesRemoved).toBe(0);
    expect(status.errors.join('\n')).toMatch(
      /kept 1 known files below folders that could not be read/,
    );
    expect((await findItem('A Legend')).files).toHaveLength(1);
  });

  describe('routes', () => {
    it('lists libraries and items, with search', async () => {
      const libraries = (await app.inject('/api/libraries')).json();
      expect(
        libraries.map((l: { name: string; itemCount: number }) => [l.name, l.itemCount]),
      ).toEqual([
        ['Movies', 3],
        ['Series', 1],
        ['Anime', 3],
      ]);
      const movies = libraries.find((l: { name: string }) => l.name === 'Movies');

      const page = (await app.inject(`/api/libraries/${movies.id}/items?search=leg`)).json();
      expect(page).toMatchObject({ total: 1, page: 1, items: [{ title: 'A Legend', year: 2024 }] });

      const unmatched = (
        await app.inject(`/api/libraries/${movies.id}/items?status=UNMATCHED`)
      ).json();
      expect(unmatched.items.map((i: { title: string }) => i.title)).toEqual([
        'Broken',
        'Unknown Film',
      ]);
    });

    it('returns item details and serves the poster', async () => {
      const legend = await findItem('A Legend');
      const details = (await app.inject(`/api/items/${legend.id}`)).json();
      expect(details).toMatchObject({
        title: 'A Legend',
        posterUrl: '/api/images/media/Movies/A%20Legend%20(2024)/poster.jpg',
        backdropUrl: '/api/images/tmdb/w1280/legend-bg.jpg',
        genres: ['Drama'],
        cast: [
          { name: 'Someone', character: 'Lead', profileUrl: '/api/images/tmdb/w185/someone.jpg' },
        ],
        ids: { tmdb: 100, imdb: 'tt100' },
        matchLocked: false,
        files: [{ videoCodec: 'hevc', width: 3840, hdrFormat: 'HDR10', size: 1 }],
      });

      const poster = await app.inject(details.posterUrl);
      expect(poster.statusCode).toBe(200);
      expect(poster.headers['content-type']).toBe('image/jpeg');
      expect(poster.body).toBe('jpeg');

      expect((await app.inject('/api/images/media/..%2F..%2Fetc/passwd.jpg')).statusCode).toBe(404);
    });

    it('corrects a match by hand and can undo it', async () => {
      const unknown = await findItem('Unknown Film');
      const candidates = (await app.inject(`/api/items/${unknown.id}/candidates`)).json();
      expect(candidates).toEqual([
        { provider: 'tmdb', id: 101, title: 'Totally Different', year: 1999 },
      ]);

      const matched = await app.inject({
        method: 'PUT',
        url: `/api/items/${unknown.id}/match`,
        payload: { provider: 'tmdb', id: 101 },
      });
      expect(matched.json()).toMatchObject({
        title: 'Totally Different',
        metadataStatus: 'MATCHED',
        matchLocked: true,
        ids: { tmdb: 101 },
      });

      // A refresh fetches every title again, by its known id, and keeps the locked match.
      tmdb.fetched = [];
      const refreshed = await scanner.scan({ refreshMetadata: true });
      expect(refreshed.itemsTotal).toBe(await prisma.mediaItem.count());
      expect(tmdb.fetched.sort((a, b) => a - b)).toEqual([100, 101, 200, 300, 400, 500]);
      expect(await findItem('Totally Different')).toMatchObject({ tmdbId: 101, matchLocked: true });

      const undone = await app.inject({ method: 'DELETE', url: `/api/items/${unknown.id}/match` });
      expect(undone.json()).toMatchObject({
        title: 'Unknown Film',
        year: 1999,
        metadataStatus: 'UNMATCHED',
        matchLocked: false,
      });
    });

    it('streams files with range requests', async () => {
      const agent = await findItem('Agent from Above');
      const fileId = agent.seasons[0]?.episodes[0]?.files[0]?.id;
      const url = `/api/files/${fileId}/stream`;

      const full = await app.inject(url);
      expect(full.statusCode).toBe(200);
      expect(full.body).toBe('0123456789');
      expect(full.headers).toMatchObject({
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
        'content-length': '10',
      });

      const part = await app.inject({ url, headers: { range: 'bytes=2-5' } });
      expect(part.statusCode).toBe(206);
      expect(part.body).toBe('2345');
      expect(part.headers['content-range']).toBe('bytes 2-5/10');
      expect(part.headers['content-length']).toBe('4');

      const tail = await app.inject({ url, headers: { range: 'bytes=-3' } });
      expect(tail.body).toBe('789');

      const outside = await app.inject({ url, headers: { range: 'bytes=50-' } });
      expect(outside.statusCode).toBe(416);
      expect(outside.headers['content-range']).toBe('bytes */10');

      const head = await app.inject({ method: 'HEAD', url });
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe('10');
      expect(head.body).toBe('');

      expect(
        (await app.inject('/api/files/00000000-0000-4000-8000-000000000000/stream')).statusCode,
      ).toBe(404);
    });

    it('returns a file with its title and episode', async () => {
      const agent = await findItem('Agent from Above');
      const fileId = agent.seasons[0]?.episodes[0]?.files[0]?.id;
      expect((await app.inject(`/api/files/${fileId}`)).json()).toMatchObject({
        file: { id: fileId, videoCodec: 'hevc', size: 10 },
        item: { id: agent.id, title: 'Agent from Above', type: 'SHOW' },
        episode: { seasonNumber: 1, episodeNumber: 1, title: 'Episode 1 title' },
      });
      const legend = await findItem('A Legend');
      const movie = (await app.inject(`/api/files/${legend.files[0]?.id}`)).json();
      expect(movie.item.title).toBe('A Legend');
      expect(movie.episode).toBeUndefined();
    });

    it('reports codec statistics', async () => {
      const stats = (await app.inject('/api/stats/codecs')).json();
      const files = await prisma.mediaFile.count();
      expect(stats.files).toBe(files);
      // The fake prober reports HEVC 2160p HDR10 with E-AC3 audio; the broken file has no data.
      expect(stats.videoCodecs).toEqual({ hevc: files - 1, unknown: 1 });
      expect(stats.resolutions['2160p']).toBe(files - 1);
      expect(stats.hdr).toEqual({ HDR10: files - 1, SDR: 1 });
      expect(stats.defaultAudioCodecs).toEqual({ eac3: files - 1, none: 1 });
    });

    it('lists subtitles: embedded text and image tracks, and files next to the video', async () => {
      const legend = await findItem('A Legend');
      const list = (await app.inject(`/api/files/${legend.files[0]?.id}/subtitles`)).json();
      expect(list).toEqual([
        {
          id: 'embedded:2',
          source: 'embedded',
          language: 'eng',
          label: 'English',
          codec: 'subrip',
          forced: false,
          hearingImpaired: false,
          offsetMs: 0,
          supported: true,
          streamIndex: 2,
        },
        {
          id: 'embedded:3',
          source: 'embedded',
          language: 'nld',
          codec: 'hdmv_pgs_subtitle',
          forced: false,
          hearingImpaired: false,
          offsetMs: 0,
          supported: false,
        },
        {
          id: expect.any(String),
          source: 'external',
          language: 'nld',
          forced: false,
          hearingImpaired: false,
          offsetMs: 0,
          supported: true,
          url: expect.stringMatching(/^\/api\/subtitles\/.+\/vtt$/),
        },
      ]);

      // The sidecar file, as WebVTT.
      const vtt = await app.inject(list[2].url);
      expect(vtt.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(vtt.body).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo\n');
    });

    it('keeps a time shift per subtitle, also for embedded tracks', async () => {
      const legend = await findItem('A Legend');
      const fileId = legend.files[0]?.id;
      const shifted = await app.inject({
        method: 'PUT',
        url: `/api/files/${fileId}/subtitles/embedded:2/offset`,
        payload: { offsetMs: -1500 },
      });
      expect(shifted.json()).toMatchObject({ id: 'embedded:2', offsetMs: -1500, streamIndex: 2 });
      const list = (await app.inject(`/api/files/${fileId}/subtitles`)).json();
      expect(list[0].offsetMs).toBe(-1500);
      const external = await app.inject({
        method: 'PUT',
        url: `/api/files/${fileId}/subtitles/${list[2].id}/offset`,
        payload: { offsetMs: 250 },
      });
      expect(external.json().offsetMs).toBe(250);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/files/${fileId}/subtitles/embedded:9/offset`,
            payload: { offsetMs: 1 },
          })
        ).statusCode,
      ).toBe(404);
    });

    it('prepares an embedded track for a Chromecast: read whole, then with a url', async () => {
      const legend = await findItem('A Legend');
      const fileId = legend.files[0]?.id;
      const first = await app.inject({
        method: 'POST',
        url: `/api/files/${fileId}/subtitles/embedded:2/prepare`,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ id: 'embedded:2', readProgress: 0 });
      expect(first.json()).not.toHaveProperty('url');
      let ready: { url?: string } = {};
      for (let i = 0; i < 100 && !ready.url; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        ready = (
          await app.inject({
            method: 'POST',
            url: `/api/files/${fileId}/subtitles/embedded:2/prepare`,
          })
        ).json();
      }
      expect(ready).toMatchObject({ id: 'embedded:2', url: expect.stringMatching(/\/vtt$/) });
      expect(transcoderCalls.filter((call) => call === 'POST /subtitles')).toHaveLength(1);
      expect((await app.inject(ready.url ?? '')).body).toContain('Embedded');
      // An image track that can't be read as text, and one that doesn't exist.
      const image = await app.inject({
        method: 'POST',
        url: `/api/files/${fileId}/subtitles/embedded:3/prepare`,
      });
      expect(image.statusCode).toBe(422);
      const missing = await app.inject({
        method: 'POST',
        url: `/api/files/${fileId}/subtitles/embedded:9/prepare`,
      });
      expect(missing.statusCode).toBe(404);

      // As it was for the next test: not read yet.
      await prisma.subtitle.updateMany({
        where: { mediaFileId: fileId, source: 'EMBEDDED' },
        data: { path: null },
      });
      transcoderCalls.length = 0;
    });

    it('reads an embedded track through the transcoder and keeps it once complete', async () => {
      const legend = await findItem('A Legend');
      const fileId = legend.files[0]?.id;
      const image = await app.inject({
        method: 'POST',
        url: `/api/files/${fileId}/subtitles/extract`,
        payload: { streamIndex: 3, start: 0 },
      });
      expect(image.statusCode).toBe(422);

      const job = await app.inject({
        method: 'POST',
        url: `/api/files/${fileId}/subtitles/extract`,
        payload: { streamIndex: 2, start: 0 },
      });
      expect(job.statusCode).toBe(201);
      const read = await app.inject(`/api/subtitle-extractions/${job.json().id}`);
      expect(read.headers['x-complete']).toBe('1');
      expect(read.body).toContain('Embedded');
      expect(transcoderCalls).toEqual([
        'POST /subtitles',
        'GET /subtitles/44444444-4444-4444-8444-444444444444',
      ]);

      // Next time it is there at once, and the shift is kept.
      const list = (await app.inject(`/api/files/${fileId}/subtitles`)).json();
      expect(list[0]).toMatchObject({
        id: 'embedded:2',
        offsetMs: -1500,
        url: expect.stringMatching(/\/vtt$/),
      });
      expect(list[0]).not.toHaveProperty('streamIndex');
      expect((await app.inject(list[0].url)).body).toContain('Embedded');
    });

    it('searches OpenSubtitles and downloads a subtitle once', async () => {
      const legend = await findItem('A Legend');
      const fileId = legend.files[0]?.id;
      const found = (
        await app.inject(`/api/files/${fileId}/subtitles/search?languages=nld,eng`)
      ).json();
      expect(found).toEqual([
        expect.objectContaining({ id: '555', language: 'nld', matchesFile: true }),
      ]);
      expect(searches[0]).toMatchObject({
        kind: 'movie',
        title: 'A Legend',
        tmdbId: 100,
        imdbId: 'tt100',
        languages: ['nld', 'eng'],
      });

      const downloaded = await app.inject({
        method: 'POST',
        url: `/api/files/${fileId}/subtitles/download`,
        payload: { id: '555' },
      });
      expect(downloaded.statusCode).toBe(201);
      expect(downloaded.json()).toMatchObject({
        source: 'opensubtitles',
        language: 'nld',
        label: 'A.Legend.2024.NL',
      });
      expect((await app.inject(downloaded.json().url)).body).toContain('Gedownload');
      // Downloaded once: the second request uses what is stored.
      await app.inject({
        method: 'POST',
        url: `/api/files/${fileId}/subtitles/download`,
        payload: { id: '555' },
      });
      expect(subtitleDownloads).toEqual(['555']);

      const list = (await app.inject(`/api/files/${fileId}/subtitles`)).json();
      expect(list.map((s: { source: string }) => s.source)).toEqual([
        'embedded',
        'embedded',
        'external',
        'opensubtitles',
      ]);
      expect(
        (await app.inject({ method: 'DELETE', url: `/api/subtitles/${downloaded.json().id}` }))
          .statusCode,
      ).toBe(204);
      expect(
        (await app.inject({ method: 'DELETE', url: `/api/subtitles/${list[2].id}` })).statusCode,
      ).toBe(400);
      expect((await app.inject(downloaded.json().url)).statusCode).toBe(404);
    });

    it('starts scans and rejects bad input', async () => {
      const started = await app.inject({ method: 'POST', url: '/api/scan', payload: {} });
      expect(started.statusCode).toBe(202);
      const again = await app.inject({ method: 'POST', url: '/api/scan', payload: {} });
      expect(again.statusCode).toBe(409);
      for (let i = 0; i < 100 && (await app.inject('/api/scan')).json().running; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await app.inject('/api/scan')).json()).toMatchObject({
        running: false,
        phase: 'done',
      });

      expect((await app.inject('/api/items/not-a-uuid')).statusCode).toBe(400);
      const outside = await app.inject({
        method: 'POST',
        url: '/api/libraries',
        payload: { name: 'Bad', type: 'MOVIES', path: '../etc' },
      });
      expect(outside.statusCode).toBe(400);
      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/libraries',
        payload: { name: 'Again', type: 'MOVIES', path: 'Movies' },
      });
      expect(duplicate.statusCode).toBe(409);
    });
  });
});
