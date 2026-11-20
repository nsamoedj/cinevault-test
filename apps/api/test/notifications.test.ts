// "Mijn lijst" and notifications: what gives one, settings, quiet hours, the
// inbox and web push. Against a real PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { deviceLabel, NotificationEvents, newEpisodesBody } from '../src/notifications/events.js';
import { type PushMessage, type PushSender, WebPushSender } from '../src/notifications/push.js';
import { NotificationService } from '../src/notifications/service.js';
import { afterQuietHours, localTime } from '../src/notifications/time.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const TZ = 'Europe/Amsterdam';

describe('notification texts and times', () => {
  it('holds push messages during quiet hours until 08:00 local time', () => {
    // 2026-10-18 is summer time: UTC+2.
    const night = Date.parse('2026-10-18T21:30:00Z'); // 23:30
    expect(new Date(afterQuietHours(night, TZ)).toISOString()).toBe('2026-10-19T06:00:00.000Z');
    const early = Date.parse('2026-10-19T04:15:00Z'); // 06:15
    expect(new Date(afterQuietHours(early, TZ)).toISOString()).toBe('2026-10-19T06:00:00.000Z');
    const day = Date.parse('2026-10-18T10:00:00Z');
    expect(afterQuietHours(day, TZ)).toBe(day);
    expect(localTime(night, TZ)).toEqual({ date: '2026-10-18', hour: 23, minute: 30 });
  });

  it('describes new episodes', () => {
    expect(newEpisodesBody([{ seasonNumber: 2, episodeNumber: 5, title: 'Vuur' }])).toBe(
      'Nieuwe aflevering: S2 · A5 · Vuur',
    );
    expect(
      newEpisodesBody([
        { seasonNumber: 2, episodeNumber: 7 },
        { seasonNumber: 2, episodeNumber: 5 },
        { seasonNumber: 2, episodeNumber: 6 },
      ]),
    ).toBe('3 nieuwe afleveringen: S2 · A5–A7');
    expect(
      newEpisodesBody([
        { seasonNumber: 3, episodeNumber: 1 },
        { seasonNumber: 3, episodeNumber: 2 },
      ]),
    ).toBe('Seizoen 3 staat klaar: 2 afleveringen');
  });

  it('names the device of a login', () => {
    expect(deviceLabel('okhttp/4.12.0')).toBe('de Android-app');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      ),
    ).toBe('Chrome op Windows');
    expect(
      deviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      ),
    ).toBe('Safari op Mac');
    expect(deviceLabel(undefined)).toBe('een onbekend apparaat');
  });
});

describe('web push sender', () => {
  it('sends an encrypted message with VAPID, and knows a gone subscription', async () => {
    const received: { headers: Record<string, unknown>; size: number }[] = [];
    let status = 201;
    // web-push only speaks HTTPS: a push service of our own, with a certificate made here.
    const dir = mkdtempSync(path.join(tmpdir(), 'cinevault-push-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const tls = {
      key: readFileSync(path.join(dir, 'key.pem')),
      cert: readFileSync(path.join(dir, 'cert.pem')),
    };
    const verify = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const server = createServer(tls, (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        received.push({ headers: request.headers, size: Buffer.concat(chunks).length });
        response.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const settings = new Map<string, string>();
    // Just enough of Prisma for the key store.
    const prisma = {
      appSetting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
          settings.has(where.key) ? { value: settings.get(where.key) } : null,
        findUniqueOrThrow: async ({ where }: { where: { key: string } }) => ({
          value: settings.get(where.key),
        }),
        upsert: async ({ create }: { create: { key: string; value: string } }) => {
          if (!settings.has(create.key)) settings.set(create.key, create.value);
        },
      },
    } as unknown as PrismaClient;
    const sender = new WebPushSender(prisma, 'mailto:test@example.org');
    const key = await sender.publicKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // The keys stay.
    expect(await new WebPushSender(prisma, 'mailto:test@example.org').publicKey()).toBe(key);

    // A browser's keys (P-256 and 16 random bytes), as PushSubscription.toJSON() has them.
    const { createECDH, randomBytes } = await import('node:crypto');
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const target = {
      endpoint: `https://127.0.0.1:${port}/push/abc`,
      p256dh: browser.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    };
    const message: PushMessage = { id: 1, title: 'T', body: 'B', url: '/', tag: 'test-1' };
    expect(await sender.send(target, message)).toBe('sent');
    expect(received[0]?.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      ttl: '86400',
    });
    expect(String(received[0]?.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    expect(received[0]?.size).toBeGreaterThan(80);

    status = 410;
    expect(await sender.send(target, message)).toBe('gone');
    status = 500;
    expect(await sender.send(target, message)).toBe('failed');
    server.close();
    if (verify === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = verify;
  });
});

describe.skipIf(!databaseUrl)('my list and notifications (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let service: NotificationService;
  let events: NotificationEvents;
  let clock = Date.parse('2026-10-18T12:00:00Z'); // 14:00 in Amsterdam
  const pushed: { endpoint: string; message: PushMessage }[] = [];
  let admin = { id: '', cookie: '' };
  let member = { id: '', cookie: '' };
  let library = '';
  let movies = '';
  let show = '';
  let oldFile = '';
  let watchedMovie = '';

  const push: PushSender = {
    publicKey: async () => 'test-public-key',
    send: async (target, message) => {
      pushed.push({ endpoint: target.endpoint, message });
      return target.endpoint.includes('gone') ? 'gone' : 'sent';
    },
  };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });
  const inbox = async (who: { id: string }) =>
    prisma.notification.findMany({ where: { userId: who.id }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "WatchProgress", "User", "Session", "Notification", "PushSubscription", "MyListEntry", "AppSetting" CASCADE',
    );
    service = new NotificationService({ prisma, push, timeZone: TZ, now: () => clock });
    events = new NotificationEvents(prisma, service, TZ, () => clock);
    const services = {
      prisma,
      scanner: {},
      metadata: {},
      images: {},
      mediaRoot: '/media',
      notifications: service,
      notificationEvents: events,
    };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: TEST_AUTH,
    });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Beheer', username: 'beheer', password: 'een-lang-wachtwoord' },
    });
    admin = {
      id: setup.json<{ user: { id: string } }>().user.id,
      cookie: String(setup.headers['set-cookie']).split(';')[0] ?? '',
    };
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
      headers: { 'user-agent': 'okhttp/4.12.0' },
      payload: { username: 'lid', password: 'nog-een-wachtwoord' },
    });
    member = {
      id: login.json<{ user: { id: string } }>().user.id,
      cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    };

    library = (
      await prisma.library.create({
        data: { name: 'Series', type: 'SHOWS', path: 'Series', lastScannedAt: new Date(0) },
      })
    ).id;
    movies = (
      await prisma.library.create({
        data: { name: 'Films', type: 'MOVIES', path: 'Movies', lastScannedAt: new Date(0) },
      })
    ).id;
    const old = new Date('2026-09-01T00:00:00Z');
    const created = await prisma.mediaItem.create({
      data: {
        libraryId: library,
        type: 'SHOW',
        path: 'Series/Bluey',
        title: 'Bluey',
        sortTitle: 'bluey',
        metadataStatus: 'MATCHED',
        posterPath: 'tmdb:w500/bluey.jpg',
        createdAt: old,
        seasons: {
          create: {
            seasonNumber: 1,
            createdAt: old,
            episodes: {
              create: {
                episodeNumber: 1,
                title: 'Magie',
                createdAt: old,
                files: {
                  create: {
                    path: 'Series/Bluey/S01E01.mkv',
                    size: 1n,
                    modifiedAt: old,
                    createdAt: old,
                  },
                },
              },
            },
          },
        },
      },
      include: { seasons: { include: { episodes: { include: { files: true } } } } },
    });
    show = created.id;
    oldFile = created.seasons[0]?.episodes[0]?.files[0]?.id ?? '';
    // The admin watched the first episode: follows the show.
    await prisma.watchProgress.create({
      data: { userId: admin.id, mediaFileId: oldFile, positionMs: 60_000, completed: true },
    });
    // The admin watched a movie whose recommendations include tmdb 500.
    watchedMovie = (
      await prisma.mediaItem.create({
        data: {
          libraryId: movies,
          type: 'MOVIE',
          path: 'Movies/Dune',
          title: 'Dune',
          sortTitle: 'dune',
          metadataStatus: 'MATCHED',
          tmdbId: 438631,
          recommendedTmdbIds: [500],
          createdAt: old,
          files: {
            create: { path: 'Movies/Dune/Dune.mkv', size: 1n, modifiedAt: old, createdAt: old },
          },
        },
        include: { files: true },
      })
    ).id;
    const duneFile = await prisma.mediaFile.findFirstOrThrow({
      where: { mediaItemId: watchedMovie },
    });
    await prisma.watchProgress.create({
      data: { userId: admin.id, mediaFileId: duneFile.id, positionMs: 10_000 },
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('keeps titles in "Mijn lijst"', async () => {
    expect(
      (await app.inject({ method: 'PUT', url: `/api/my-list/${show}`, ...as(member) })).statusCode,
    ).toBe(204);
    // Twice is fine.
    await app.inject({ method: 'PUT', url: `/api/my-list/${show}`, ...as(member) });
    const list = await app.inject({ url: '/api/my-list', ...as(member) });
    expect(list.json()).toEqual([expect.objectContaining({ title: 'Bluey', inMyList: true })]);
    const details = await app.inject({ url: `/api/items/${show}`, ...as(member) });
    expect(details.json()).toMatchObject({ inMyList: true });
    // Per profile.
    expect((await app.inject({ url: '/api/my-list', ...as(admin) })).json()).toEqual([]);
    expect((await app.inject({ url: `/api/items/${show}`, ...as(admin) })).json()).toMatchObject({
      inMyList: false,
    });
    const home = await app.inject({ url: '/api/home', ...as(member) });
    expect(home.json<{ rows: { id: string; title: string }[] }>().rows[0]).toMatchObject({
      id: 'my-list',
      title: 'Mijn lijst',
    });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/my-list/00000000-0000-0000-0000-000000000000',
          ...as(member),
        })
      ).statusCode,
    ).toBe(404);
    // Scripts have no list.
    expect(
      (
        await app.inject({
          url: '/api/my-list',
          headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('tells about a new login, but not about the first account', async () => {
    expect(await inbox(admin)).toEqual([]);
    expect(await inbox(member)).toEqual([
      expect.objectContaining({
        type: 'new-login',
        title: 'Nieuwe login op je account',
        body: expect.stringContaining('Op de Android-app, om 14:00'),
      }),
    ]);
  });

  it('tells followers about new episodes after a scan, once', async () => {
    const startedAt = new Date(clock - 60_000);
    const season = await prisma.season.findFirstOrThrow({ where: { mediaItemId: show } });
    for (const n of [2, 3]) {
      // Made at the test's clock, not the real one: a later scan must not see them as new.
      await prisma.episode.create({
        data: {
          seasonId: season.id,
          episodeNumber: n,
          stillPath: `tmdb:w300/bluey-${n}.jpg`,
          createdAt: new Date(clock),
          files: {
            create: {
              path: `Series/Bluey/S01E0${n}.mkv`,
              size: 1n,
              modifiedAt: new Date(),
              createdAt: new Date(clock),
            },
          },
        },
      });
    }
    // An upgrade: a new file for an episode that was here. Not new.
    await prisma.mediaFile.create({
      data: {
        path: 'Series/Bluey/S01E01 Bluray-2160p.mkv',
        size: 1n,
        modifiedAt: new Date(),
        createdAt: new Date(clock),
        episodeId: (await prisma.episode.findFirstOrThrow({ where: { episodeNumber: 1 } })).id,
      },
    });
    const scan = { libraryId: library, libraryName: 'Series', startedAt, firstScan: false };
    expect(await events.libraryScanned({ ...scan, firstScan: true })).toBe(0);
    expect(await events.libraryScanned(scan)).toBe(2);
    // The member has it in the list; the admin watched an episode.
    for (const who of [member, admin]) {
      expect((await inbox(who)).filter((n) => n.type === 'new-episodes')).toEqual([
        expect.objectContaining({
          title: 'Bluey',
          body: '2 nieuwe afleveringen: S1 · A2–A3',
          itemId: show,
        }),
      ]);
    }
    expect(await events.libraryScanned(scan)).toBe(0);
    // For the phone's notification: the poster, and the first new episode's picture.
    const list = await app.inject({ url: '/api/notifications', ...as(member) });
    expect(
      list.json<{ items: { type: string }[] }>().items.find((n) => n.type === 'new-episodes'),
    ).toMatchObject({
      posterUrl: '/api/images/tmdb/w500/bluey.jpg',
      stillUrl: '/api/images/tmdb/w300/bluey-2.jpg',
    });
  });

  it('recommends a new title because of what someone watched, and tells admins about unmatched ones', async () => {
    const startedAt = new Date(clock - 60_000);
    await prisma.mediaItem.create({
      data: {
        libraryId: movies,
        type: 'MOVIE',
        path: 'Movies/Dune Part Two',
        title: 'Dune: Part Two',
        sortTitle: 'dune: part two',
        metadataStatus: 'MATCHED',
        tmdbId: 500,
      },
    });
    await prisma.mediaItem.create({
      data: {
        libraryId: movies,
        type: 'MOVIE',
        path: 'Movies/Vreemd',
        title: 'Vreemd',
        sortTitle: 'vreemd',
        metadataStatus: 'UNMATCHED',
      },
    });
    await events.libraryScanned({
      libraryId: movies,
      libraryName: 'Films',
      startedAt,
      firstScan: false,
    });
    const adminInbox = await inbox(admin);
    expect(adminInbox.find((n) => n.type === 'recommended')).toMatchObject({
      title: 'Nieuw: Dune: Part Two',
      body: 'Omdat je Dune keek. Nu in Films.',
    });
    expect(adminInbox.find((n) => n.type === 'admin-unmatched')).toMatchObject({
      title: 'Niet gematcht in Films',
      path: '/attention',
    });
    // The member watched nothing and is no admin.
    expect(
      (await inbox(member)).filter((n) => ['recommended', 'admin-unmatched'].includes(n.type)),
    ).toEqual([]);
  });

  it('tells followers on the day an episode airs, from 10:00', async () => {
    await prisma.mediaItem.update({
      where: { id: show },
      data: {
        nextEpisodeSeason: 2,
        nextEpisodeNumber: 1,
        nextEpisodeTitle: 'Terug',
        nextEpisodeAirDate: new Date('2026-10-19T00:00:00Z'),
      },
    });
    clock = Date.parse('2026-10-19T06:30:00Z'); // 08:30
    expect(await events.airingToday()).toBe(0);
    clock = Date.parse('2026-10-19T08:30:00Z'); // 10:30
    expect(await events.airingToday()).toBe(2);
    expect((await inbox(member)).at(-1)).toMatchObject({
      type: 'airing',
      body: 'Vandaag verschijnt S2 · A1 · Terug',
    });
    expect(await events.airingToday()).toBe(0);
  });

  it('follows the settings, and holds notifications during quiet hours', async () => {
    const settings = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      ...as(member),
      payload: { newEpisodes: false },
    });
    expect(settings.json()).toMatchObject({ newEpisodes: false, airing: true, quietHours: true });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/notifications/settings',
          ...as(member),
          payload: { unknown: true },
        })
      ).statusCode,
    ).toBe(400);

    clock = Date.parse('2026-10-19T21:30:00Z'); // 23:30
    const startedAt = new Date(clock - 60_000);
    const season = await prisma.season.findFirstOrThrow({ where: { mediaItemId: show } });
    await prisma.episode.create({
      data: {
        seasonId: season.id,
        episodeNumber: 4,
        createdAt: new Date(clock),
        files: {
          create: {
            path: 'Series/Bluey/S01E04.mkv',
            size: 1n,
            modifiedAt: new Date(clock),
            createdAt: new Date(clock),
          },
        },
      },
    });
    await events.libraryScanned({
      libraryId: library,
      libraryName: 'Series',
      startedAt,
      firstScan: false,
    });
    const memberNew = (await inbox(member)).filter((n) => n.body.includes('A4'));
    expect(memberNew).toEqual([]);
    const adminNew = (await inbox(admin)).filter((n) => n.body.includes('A4'));
    expect(adminNew.map((n) => n.deliverAt.toISOString())).toEqual(['2026-10-20T06:00:00.000Z']);
    // Not in the inbox until the morning.
    const night = await app.inject({ url: '/api/notifications', ...as(admin) });
    expect(night.json<{ items: { body: string }[] }>().items.map((n) => n.body)).not.toContain(
      'Nieuwe aflevering: S1 · A4',
    );
    clock = Date.parse('2026-10-20T06:00:00Z');
    const morning = await app.inject({ url: '/api/notifications', ...as(admin) });
    expect(morning.json<{ items: { body: string }[] }>().items[0]?.body).toBe(
      'Nieuwe aflevering: S1 · A4',
    );
  });

  it('lists, marks read and pushes to subscribed browsers', async () => {
    const list = await app.inject({ url: '/api/notifications', ...as(member) });
    const body = list.json<{
      items: { id: number; read: boolean; type: string }[];
      unread: number;
    }>();
    expect(body.unread).toBe(body.items.length);
    expect(body.items.every((n) => !n.read)).toBe(true);
    const first = body.items.at(-1)?.id ?? 0;
    await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      ...as(member),
      payload: { ids: [first] },
    });
    expect(
      (await app.inject({ url: '/api/notifications', ...as(member) })).json<{ unread: number }>()
        .unread,
    ).toBe(body.unread - 1);
    await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      ...as(member),
      payload: { all: true },
    });
    expect(
      (await app.inject({ url: '/api/notifications', ...as(member) })).json<{ unread: number }>()
        .unread,
    ).toBe(0);
    // Someone else's ids do nothing.
    const adminUnread = (await app.inject({ url: '/api/notifications', ...as(admin) })).json<{
      unread: number;
    }>().unread;
    expect(adminUnread).toBeGreaterThan(0);

    expect(
      (await app.inject({ url: '/api/notifications/push/key', ...as(member) })).json(),
    ).toEqual({ publicKey: 'test-public-key' });
    for (const endpoint of ['https://push.example/ok', 'https://push.example/gone']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notifications/push',
        ...as(member),
        payload: { endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } },
      });
      expect(response.statusCode).toBe(204);
    }
    // Only HTTPS push services.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/notifications/push',
          ...as(member),
          payload: {
            endpoint: 'http://push.example/x',
            keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
          },
        })
      ).statusCode,
    ).toBe(400);
    // Everything before was done (pushed or skipped); a test notification goes out now.
    await service.dispatch();
    pushed.length = 0;
    await app.inject({ method: 'POST', url: '/api/notifications/test', ...as(member) });
    await service.dispatch();
    expect(pushed.map((p) => p.endpoint).sort()).toEqual([
      'https://push.example/gone',
      'https://push.example/ok',
    ]);
    expect(pushed[0]?.message).toMatchObject({ title: 'CineVault', url: '/profile' });
    // The gone one is forgotten.
    expect((await prisma.pushSubscription.findMany()).map((s) => s.endpoint)).toEqual([
      'https://push.example/ok',
    ]);
    await app.inject({
      method: 'POST',
      url: '/api/notifications/push/remove',
      ...as(member),
      payload: { endpoint: 'https://push.example/ok' },
    });
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  it("answers a phone's waiting request as soon as there is a new notification", async () => {
    const latest = (await inbox(member)).at(-1)?.id ?? 0;
    // Nothing newer: 204 after the timeout.
    const quiet = await app.inject({
      url: `/api/notifications/wait?after=${latest}&since=${clock}&timeout=1`,
      ...as(member),
    });
    expect(quiet.statusCode).toBe(204);
    // Something newer while it waits: at once, with the inbox.
    const started = Date.now();
    const waiting = app.inject({
      url: `/api/notifications/wait?after=${latest}&since=${clock}&timeout=30`,
      ...as(member),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await service.notify([
      { userId: member.id, type: 'test', title: 'Test', body: 'Hallo', key: `wait-${latest}` },
    ]);
    const answer = await waiting;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(answer.statusCode).toBe(200);
    expect(answer.json<{ items: { id: number; title: string }[] }>().items[0]).toMatchObject({
      title: 'Test',
    });
    // Older than `after`: at once too (the phone missed it).
    const missed = await app.inject({
      url: `/api/notifications/wait?after=${latest}&timeout=30`,
      ...as(member),
    });
    expect(missed.statusCode).toBe(200);
    // Not someone else's.
    const checkedAt = Number(missed.headers['x-checked-at']);
    expect(checkedAt).toBe(clock);
    const other = await app.inject({
      url: `/api/notifications/wait?after=${latest + 1000}&since=${checkedAt}&timeout=1`,
      ...as(admin),
    });
    expect(other.statusCode).toBe(204);
    // Held back during quiet hours (an older id), deliverable now: it wakes the phone too.
    const newest = (await inbox(member)).at(-1)?.id ?? 0;
    await prisma.notification.create({
      data: {
        userId: member.id,
        type: 'test',
        title: 'Uit de nacht',
        body: 'Om 08:00',
        key: `held-${newest}`,
        createdAt: new Date(clock - 3_600_000),
        deliverAt: new Date(clock + 60_000),
      },
    });
    const beforeMorning = await app.inject({
      url: `/api/notifications/wait?after=${newest + 1}&since=${checkedAt}&timeout=1`,
      ...as(member),
    });
    expect(beforeMorning.statusCode).toBe(204);
    clock += 120_000;
    const morning = await app.inject({
      url: `/api/notifications/wait?after=${newest + 1}&since=${checkedAt}&timeout=1`,
      ...as(member),
    });
    expect(morning.statusCode).toBe(200);
  });

  it('tells admins once when the transcoder stays away', async () => {
    await events.transcoderChecked(false);
    await events.transcoderChecked(false);
    expect((await inbox(admin)).filter((n) => n.type === 'admin-transcoder')).toEqual([]);
    await events.transcoderChecked(false);
    await events.transcoderChecked(false);
    expect((await inbox(admin)).filter((n) => n.type === 'admin-transcoder')).toHaveLength(1);
    expect((await inbox(member)).filter((n) => n.type === 'admin-transcoder')).toEqual([]);
    await events.transcoderChecked(true);
  });

  it('removes a title from the list', async () => {
    await app.inject({ method: 'DELETE', url: `/api/my-list/${show}`, ...as(member) });
    expect((await app.inject({ url: '/api/my-list', ...as(member) })).json()).toEqual([]);
  });
});
