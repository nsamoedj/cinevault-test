// Beheer → Gezondheid: the checks, the notifications for admins (once per
// problem, again when it gets worse), the back-up report and the routes,
// against PostgreSQL (TEST_DATABASE_URL) with a fake transcoder and Radarr.

import { execFileSync } from 'node:child_process';
import type { HealthReport, ScanStatus } from '@cinevault/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import {
  bytesLabel,
  type CertificateInfo,
  diskLevel,
  HealthService,
  worst,
} from '../src/health.js';
import { NotificationService } from '../src/notifications/service.js';
import { RadarrClient } from '../src/requests/arr.js';
import { TranscoderClient } from '../src/transcoder.js';
import { TEST_AUTH } from './auth-helpers.js';

const TB = 1e12;
const DAY = 24 * 60 * 60_000;

describe('health helpers', () => {
  it('labels sizes and levels', () => {
    expect(bytesLabel(1.25 * TB)).toBe('1,3 TB');
    expect(bytesLabel(350e9)).toBe('350 GB');
    expect(bytesLabel(42e6)).toBe('42 MB');
    expect(worst(['ok', 'unknown', 'warning'])).toBe('warning');
    expect(worst(['ok', 'error', 'warning'])).toBe('error');
    const limits = { warn: { share: 0.05, bytes: 200e9 }, error: { share: 0.02, bytes: 50e9 } };
    expect(diskLevel({ free: 2 * TB, total: 16 * TB }, limits)).toBe('ok');
    expect(diskLevel({ free: 0.5 * TB, total: 16 * TB }, limits)).toBe('warning');
    expect(diskLevel({ free: 40e9, total: 16 * TB }, limits)).toBe('error');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('health (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let health: HealthService;
  let clock = Date.parse('2026-10-21T12:00:00Z');
  const admin = { id: '', cookie: '' };
  const member = { cookie: '' };
  // What the fakes answer; the tests change it.
  const state = {
    media: { free: 4 * TB, total: 16 * TB },
    cache: { free: 200e9, total: 500e9 },
    transcoder: 'qsv' as 'qsv' | 'none' | 'down',
    certificateDays: 60,
    /** What the container sees in each library folder. */
    folders: {} as Record<string, string[]>,
    radarrIssues: [] as { type: string; message: string }[],
    scan: {
      running: false,
      phase: 'done',
      finishedAt: '2026-10-21T11:30:00Z',
      filesFound: 1,
      filesProbed: 0,
      probeErrors: 0,
      filesRemoved: 0,
      itemsTotal: 1,
      itemsMatched: 1,
      itemsUnmatched: 0,
      itemsFailed: 0,
      errors: [],
    } as ScanStatus,
  };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });
  const inbox = () =>
    prisma.notification.findMany({ where: { userId: admin.id, type: 'admin-health' } });
  const check = (report: HealthReport, id: string) => report.checks.find((c) => c.id === id);

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "MediaFile", "User", "Session", "Notification", "AppSetting" CASCADE',
    );
    const notifications = new NotificationService({
      prisma,
      push: { send: async () => 'sent' },
      timeZone: 'Europe/Amsterdam',
      now: () => clock,
    } as unknown as ConstructorParameters<typeof NotificationService>[0]);
    const transcoder = new TranscoderClient({
      url: 'http://transcoder',
      token: 'secret-token-1234567890',
      fetch: (async () => {
        if (state.transcoder === 'down') throw new TypeError('fetch failed');
        return Response.json({
          ok: true,
          ready: true,
          hwaccel: state.transcoder,
          tonemap: true,
          maxTranscodes: 2,
          maxSessions: 4,
          sessions: { running: 1, queued: 0, transcodes: 0 },
          disks: { media: state.media, tmp: { free: 300e9, total: 1 * TB } },
        });
      }) as unknown as typeof fetch,
    });
    const radarr = new RadarrClient({
      url: 'http://radarr',
      apiKey: 'key',
      fetch: (async (input: string) =>
        Response.json(
          String(input).endsWith('/health') ? state.radarrIssues : { version: '5.14.0' },
        )) as unknown as typeof fetch,
    });
    health = new HealthService({
      prisma,
      mediaRoot: '/media',
      cacheDir: '/cache',
      transcoder,
      scan: () => state.scan,
      scanIntervalMinutes: 60,
      publicDomain: 'cine-vault.nl',
      radarr,
      notifications,
      now: () => clock,
      disk: async (folder) => (folder === '/media' ? state.media : state.cache),
      list: async (folder) => state.folders[folder] ?? [],
      certificate: async (): Promise<CertificateInfo> => ({
        validTo: new Date(clock + state.certificateDays * DAY),
        issuer: "Let's Encrypt",
        trusted: true,
      }),
    });
    const services = {
      prisma,
      scanner: {},
      metadata: {},
      images: {},
      mediaRoot: '/media',
      notifications,
      health,
    };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: { ...TEST_AUTH, now: () => clock },
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Beheer', username: 'beheer', password: 'een-lang-wachtwoord' },
    });
    admin.id = setup.json<{ user: { id: string } }>().user.id;
    admin.cookie = String(setup.headers['set-cookie']).split(';')[0] ?? '';
    await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(admin),
      payload: {
        displayName: 'Lid',
        username: 'lid',
        password: 'nog-een-wachtwoord',
        role: 'USER',
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'lid', password: 'nog-een-wachtwoord' },
    });
    member.cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('is all well, except for a back-up nobody reported yet', async () => {
    const report = await health.check();
    expect(report.level).toBe('ok');
    expect(check(report, 'media-disk')).toMatchObject({
      level: 'ok',
      detail: '4 TB vrij van 16 TB (25%).',
    });
    expect(check(report, 'transcoder')?.detail).toMatch(/GPU \(QSV\), met HDR-tonemapping/);
    expect(check(report, 'certificate')?.detail).toMatch(/nog 60 dagen\), van Let's Encrypt/);
    expect(check(report, 'radarr')?.detail).toMatch(/versie 5\.14\.0/);
    expect(check(report, 'backup')?.level).toBe('unknown');
    expect(await inbox()).toHaveLength(0);
  });

  it('tells the admins about a problem once, and again when it gets worse', async () => {
    state.media = { free: 0.4 * TB, total: 16 * TB };
    state.transcoder = 'down';
    state.certificateDays = 10;
    state.radarrIssues = [{ type: 'warning', message: 'Indexers unavailable' }];
    let report = await health.check();
    expect(report.level).toBe('error');
    expect(check(report, 'media-disk')?.level).toBe('warning');
    expect(check(report, 'transcoder')).toMatchObject({ level: 'error' });
    expect(check(report, 'transcode-disk')).toBeUndefined();
    expect(check(report, 'certificate')?.level).toBe('warning');
    expect(check(report, 'radarr')?.detail).toBe('Radarr meldt: Indexers unavailable');
    expect((await inbox()).map((n) => n.title).sort()).toEqual([
      'Certificaat van cine-vault.nl: let op',
      'Mediaschijf: let op',
      'Radarr: let op',
      'Transcoder: probleem',
    ]);

    // An hour later, the same: nothing new; the same "since".
    const since = check(report, 'transcoder')?.since;
    clock += 60 * 60_000;
    report = await health.check();
    expect(await inbox()).toHaveLength(4);
    expect(check(report, 'transcoder')?.since).toBe(since);

    // Worse: the disk is nearly full.
    state.media = { free: 30e9, total: 16 * TB };
    report = await health.check();
    expect(check(report, 'media-disk')?.level).toBe('error');
    expect((await inbox()).map((n) => n.title)).toContain('Mediaschijf: probleem');

    // Fixed, and wrong again later: a new problem.
    state.transcoder = 'qsv';
    await health.check();
    state.transcoder = 'none';
    report = await health.check();
    expect(check(report, 'transcoder')?.level).toBe('warning');
    expect((await inbox()).filter((n) => n.title.startsWith('Transcoder'))).toHaveLength(2);
  });

  it('hears of back-ups from backup.ps1, and warns when they stop', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/api/admin/health/backup',
      headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` },
      payload: { file: 'cinevault-2026-10-21_1300.dump', size: 42e6 },
    });
    expect(made.statusCode).toBe(204);
    let report = (
      await app.inject({ url: '/api/admin/health', ...as(admin) })
    ).json<HealthReport>();
    expect(check(report, 'backup')).toMatchObject({
      level: 'ok',
      detail: 'De laatste net (42 MB).',
    });
    clock += 3 * DAY;
    report = await health.check();
    expect(check(report, 'backup')).toMatchObject({
      level: 'warning',
      detail: 'De laatste 3 dagen geleden (42 MB).',
    });
    clock += 5 * DAY;
    report = await health.check();
    expect(check(report, 'backup')?.level).toBe('error');
    // The scan of an hourly schedule, long ago.
    expect(check(report, 'scan')?.level).toBe('warning');
  });

  it('says when the API sees the library folders empty, as when the media disk is gone', async () => {
    const movies = await prisma.library.create({
      data: { name: 'Movies', type: 'MOVIES', path: 'Movies' },
    });
    await prisma.library.create({ data: { name: 'Series', type: 'SHOWS', path: 'Series' } });
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: movies.id,
        type: 'MOVIE',
        path: 'Movies/Film (2020)',
        title: 'Film',
        sortTitle: 'film',
      },
    });
    for (const p of ['Movies/Film (2020)/Film.mkv', 'Series/Show/S01E01.mkv']) {
      await prisma.mediaFile.create({
        data: { mediaItemId: item.id, path: p, size: 1n, modifiedAt: new Date() },
      });
    }
    state.folders = { '/media/Movies': ['Film (2020)'], '/media/Series': ['Show'] };
    let report = await health.check();
    expect(check(report, 'media-folders')).toMatchObject({
      level: 'ok',
      detail: 'De API ziet Movies, Series.',
    });

    // The share is gone: every folder looks empty in the container.
    state.folders = {};
    state.scan = {
      ...state.scan,
      finishedAt: new Date(clock).toISOString(),
      errors: [
        'Movies is empty or unavailable; kept 1 known files. Check MEDIA_ROOT and the disk.',
      ],
    };
    report = await health.check();
    const folders = check(report, 'media-folders');
    expect(folders?.level).toBe('error');
    expect(folders?.detail).toMatch(/ziet de mediamappen niet/);
    expect(folders?.hint).toMatch(/docker compose restart api transcoder/);
    expect(check(report, 'scan')?.detail).toMatch(/zie Mediamappen/);
    expect((await inbox()).map((n) => n.title)).toContain('Mediamappen: probleem');

    // One folder only: named, no advice about the disk.
    state.folders = { '/media/Movies': ['Film (2020)'] };
    report = await health.check();
    expect(check(report, 'media-folders')?.detail).toMatch(/ziet Series niet/);
    expect(check(report, 'media-folders')?.hint).toMatch(/map Series/);
    state.folders = { '/media/Movies': ['Film (2020)'], '/media/Series': ['Show'] };
  });

  it('checks the address a Chromecast gets: set, reachable, https', async () => {
    const reached: string[] = [];
    const castHealth = (castBaseUrl: string | undefined, up: boolean) =>
      new HealthService({
        prisma,
        mediaRoot: '/media',
        now: () => clock,
        disk: async () => undefined,
        list: async () => [],
        ...(castBaseUrl && { castBaseUrl }),
        reach: async (url) => {
          reached.push(url);
          return up;
        },
      });
    const cast = async (url: string | undefined, up: boolean) =>
      check(await castHealth(url, up).check(), 'cast');
    expect(await cast(undefined, true)).toMatchObject({ level: 'unknown' });
    expect((await cast(undefined, true))?.detail).toMatch(/CAST_BASE_URL is niet ingesteld/);
    expect(await cast('http://192.168.0.110:8765/', true)).toMatchObject({ level: 'warning' });
    expect((await cast('http://192.168.0.110:8765', true))?.detail).toMatch(/via http/);
    expect(await cast('https://cine-vault.nl', false)).toMatchObject({ level: 'warning' });
    expect((await cast('https://cine-vault.nl', false))?.hint).toMatch(/NAT loopback/);
    expect(await cast('https://cine-vault.nl', true)).toMatchObject({ level: 'ok' });
    expect(reached).toContain('http://192.168.0.110:8765');
  });

  it('is only for admins', async () => {
    expect((await app.inject({ url: '/api/admin/health', ...as(member) })).statusCode).toBe(403);
    const fresh = await app.inject({ url: '/api/admin/health?fresh=1', ...as(admin) });
    expect(fresh.json<HealthReport>().checks.map((c) => c.id)).toEqual([
      'media-folders',
      'media-disk',
      'cache-disk',
      'transcode-disk',
      'transcoder',
      'backup',
      'scan',
      'certificate',
      'radarr',
      'cast',
      'attention',
    ]);
  });
});
