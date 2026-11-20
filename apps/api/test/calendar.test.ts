// "Agenda": stored air dates, the list per profile, the secret link and the
// iCalendar feed. Against a real PostgreSQL (TEST_DATABASE_URL) where needed.

import { execFileSync } from 'node:child_process';
import type { CalendarLink, CalendarList } from '@cinevault/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { foldLine, icsText, renderIcs } from '../src/calendar.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { applySchedule } from '../src/scanner/apply.js';
import { TEST_AUTH } from './auth-helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Today and days from it, as YYYY-MM-DD (the tests run against the real clock). */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('iCalendar', () => {
  it('escapes text and folds long lines at 75 octets', () => {
    expect(icsText('a, b; c\\d\ne')).toBe('a\\, b\\; c\\\\d\\ne');
    const long = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    // Unfolding gives the line back, without splitting a character.
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('renders all-day events with a stable id and a link to the show', () => {
    const ics = renderIcs({
      name: 'Nina',
      baseUrl: 'https://cine-vault.nl',
      now: Date.parse('2026-10-19T12:00:00Z'),
      episodes: [
        {
          item: { id: 'abc', title: "Hell's Kitchen", type: 'SHOW', genres: [] } as never,
          seasonNumber: 24,
          episodeNumber: 3,
          title: 'Fire, Ice',
          airDate: '2026-10-31',
          available: false,
        },
      ],
    });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:CineVault – Nina');
    expect(ics).toContain('UID:abc-s24e3@cinevault');
    expect(ics).toContain('DTSTAMP:20261019T120000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261031');
    expect(ics).toContain('DTEND;VALUE=DATE:20261101');
    expect(ics).toContain("SUMMARY:Hell's Kitchen · S24 · A3 · Fire\\, Ice");
    expect(ics).toContain('URL:https://cine-vault.nl/items/abc');
  });
});

describe.skipIf(!databaseUrl)('calendar (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let admin = { cookie: '' };
  let kid = { cookie: '' };
  const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });
  const ids = { followed: '', other: '', adult: '' };

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "User", "Session", "Notification" CASCADE',
    );
    app = await buildApp({
      checkDatabase: async () => {},
      services: {
        prisma,
        scanner: {},
        metadata: {},
        images: {},
        mediaRoot: '/media',
        timeZone: 'UTC',
      } as unknown as AppServices,
      auth: TEST_AUTH,
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Nina', username: 'nina', password: 'een-lang-wachtwoord' },
    });
    admin = { cookie: String(setup.headers['set-cookie']).split(';')[0] ?? '' };
    await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(admin),
      payload: { displayName: 'Kim', username: 'kim', password: 'nog-een-wachtwoord', maxAge: 9 },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'kim', password: 'nog-een-wachtwoord' },
    });
    kid = { cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' };

    const library = await prisma.library.create({
      data: { name: 'Series', type: 'SHOWS', path: 'Series' },
    });
    const show = (title: string, ageRating: number) =>
      prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          type: 'SHOW',
          path: `Series/${title}`,
          title,
          sortTitle: title.toLowerCase(),
          ageRating,
          metadataStatus: 'MATCHED',
        },
      });
    const followed = await show('Bluey', 0);
    const other = await show('Other', 0);
    const adult = await show('Adult', 16);
    Object.assign(ids, { followed: followed.id, other: other.id, adult: adult.id });

    // Bluey: one episode aired yesterday and is here; two to come; one too old to keep.
    await applySchedule(prisma, followed.id, {
      schedule: [
        { season: 4, episode: 1, title: 'Here', airDate: day(-1) },
        { season: 4, episode: 2, title: 'Soon', overview: 'Bingo…', airDate: day(3) },
        { season: 3, episode: 9, title: 'Old', airDate: day(-60) },
      ],
      // The next episode is in the schedule too: no double.
      nextEpisode: { season: 4, episode: 2, airDate: day(3) },
    });
    await prisma.season.create({
      data: {
        mediaItemId: followed.id,
        seasonNumber: 4,
        episodes: {
          create: {
            episodeNumber: 1,
            files: {
              create: {
                path: 'Series/Bluey/Season 4/Bluey - S04E01.mkv',
                size: 1n,
                modifiedAt: new Date(),
              },
            },
          },
        },
      },
    });
    // Without a schedule, the next episode alone.
    await applySchedule(prisma, other.id, {
      nextEpisode: { season: 2, episode: 1, airDate: day(10) },
    });
    await applySchedule(prisma, adult.id, {
      schedule: [{ season: 1, episode: 1, airDate: day(5) }],
    });

    const nina = await prisma.user.findUniqueOrThrow({ where: { username: 'nina' } });
    const kim = await prisma.user.findUniqueOrThrow({ where: { username: 'kim' } });
    await prisma.myListEntry.createMany({
      data: [
        { userId: nina.id, mediaItemId: followed.id },
        { userId: nina.id, mediaItemId: adult.id },
        { userId: kim.id, mediaItemId: followed.id },
        { userId: kim.id, mediaItemId: adult.id },
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('keeps the last month and the coming year, once per episode', async () => {
    const rows = await prisma.scheduledEpisode.findMany({
      where: { mediaItemId: ids.followed },
      orderBy: { episodeNumber: 'asc' },
    });
    expect(rows.map((r) => [r.seasonNumber, r.episodeNumber, r.title])).toEqual([
      [4, 1, 'Here'],
      [4, 2, 'Soon'],
    ]);
  });

  it('lists the followed shows, with what is here already', async () => {
    const response = await app.inject({ url: '/api/calendar', ...as(admin) });
    expect(response.statusCode).toBe(200);
    const list = response.json<CalendarList>();
    expect(list.scope).toBe('following');
    expect(list.today).toBe(day(0));
    expect(
      list.episodes.map((e) => [e.item.title, e.seasonNumber, e.episodeNumber, e.available]),
    ).toEqual([
      ['Bluey', 4, 1, true],
      ['Bluey', 4, 2, false],
      ['Adult', 1, 1, false],
    ]);
    expect(list.episodes[1]).toMatchObject({ title: 'Soon', overview: 'Bingo…', airDate: day(3) });

    const all = await app.inject({ url: '/api/calendar?scope=all', ...as(admin) });
    expect(all.json<CalendarList>().episodes.map((e) => e.item.title)).toEqual([
      'Bluey',
      'Bluey',
      'Adult',
      'Other',
    ]);
  });

  it('shows a kids profile only what its age allows', async () => {
    const response = await app.inject({ url: '/api/calendar?scope=all', ...as(kid) });
    expect(response.json<CalendarList>().episodes.map((e) => e.item.title)).toEqual([
      'Bluey',
      'Bluey',
      'Other',
    ]);
  });

  it('gives a secret link whose feed needs no login, until a new link replaces it', async () => {
    const first = await app.inject({
      url: '/api/calendar/link',
      headers: { ...as(admin).headers, host: 'cine-vault.nl', 'x-forwarded-proto': 'https' },
    });
    const link = first.json<CalendarLink>();
    expect(link.url).toMatch(/^https:\/\/cine-vault\.nl\/api\/calendar\/ics\/[\w-]{32}\.ics$/);
    expect(link.webcalUrl).toBe(link.url.replace('https:', 'webcal:'));
    expect(link.googleUrl).toBe(
      `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(link.webcalUrl)}`,
    );
    expect(link.secure).toBe(true);
    // The same link the next time.
    const again = await app.inject({ url: '/api/calendar/link', ...as(admin) });
    expect(again.json<CalendarLink>().url.split('/').pop()).toBe(link.url.split('/').pop());

    const path = new URL(link.url).pathname;
    const feed = await app.inject({ url: path });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(feed.body).toContain('X-WR-CALNAME:CineVault – Nina');
    expect(feed.body).toContain('SUMMARY:Bluey · S4 · A2 · Soon');
    expect(feed.body).not.toContain('Other');

    const reset = await app.inject({ method: 'POST', url: '/api/calendar/link', ...as(admin) });
    expect(new URL(reset.json<CalendarLink>().url).pathname).not.toBe(path);
    expect((await app.inject({ url: path })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/calendar/ics/nope.ics' })).statusCode).toBe(404);
  });

  it('keeps a kids profile feed to its age too', async () => {
    const link = (await app.inject({ url: '/api/calendar/link', ...as(kid) })).json<CalendarLink>();
    expect(link.secure).toBe(false);
    const feed = await app.inject({ url: new URL(link.url).pathname });
    expect(feed.body).toContain('CineVault – Kim');
    expect(feed.body).toContain('Bluey');
    expect(feed.body).not.toContain('Adult');
  });
});
