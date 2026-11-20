// "Agenda": air dates of the shows a profile follows, as a list for the apps
// and as an iCalendar feed (RFC 5545) to subscribe to in Google Calendar,
// Apple Calendar or ICSx⁵. The feed has a secret link per profile
// (User.calendarToken), because a calendar app can't log in.
//
// Followed is what the notifications use too: in Mijn lijst, or an episode
// watched in the last 120 days (notifications/events.ts).

import { randomBytes } from 'node:crypto';
import type { CalendarEpisode, CalendarScope, ItemSummary } from '@cinevault/shared';
import type { PrismaClient } from './generated/prisma/client.js';
import { ageFilter, type Viewer } from './kids.js';
import { localTime } from './notifications/time.js';
import { withProgress } from './progress.js';

const FOLLOW_DAYS = 120;
const DAY_MS = 86_400_000;
/** The list in the apps: the last week and what comes. */
const LIST_PAST_DAYS = 7;
/** The feed: the last month (what's stored) and what comes. */
const FEED_PAST_DAYS = 30;
const MAX_EPISODES = 1000;

export function newCalendarToken(): string {
  return randomBytes(24).toString('base64url');
}

/** The shows a profile follows: in Mijn lijst, or watched lately. */
export async function followedShows(
  prisma: PrismaClient,
  userId: string,
  now = Date.now(),
): Promise<string[]> {
  const [listed, watched] = await Promise.all([
    prisma.myListEntry.findMany({
      where: { userId, mediaItem: { type: 'SHOW' } },
      select: { mediaItemId: true },
    }),
    prisma.watchProgress.findMany({
      where: {
        userId,
        updatedAt: { gt: new Date(now - FOLLOW_DAYS * DAY_MS) },
        mediaFile: { episode: { isNot: null } },
      },
      distinct: ['mediaFileId'],
      select: {
        mediaFile: {
          select: { episode: { select: { season: { select: { mediaItemId: true } } } } },
        },
      },
    }),
  ]);
  const ids = new Set(listed.map((e) => e.mediaItemId));
  for (const row of watched) {
    const id = row.mediaFile.episode?.season.mediaItemId;
    if (id) ids.add(id);
  }
  return [...ids];
}

interface Options {
  userId: string;
  viewer?: Viewer;
  scope: CalendarScope;
  timeZone: string;
  pastDays: number;
  now?: number;
}

/** Episodes with an air date from `pastDays` ago on, the soonest first. */
async function calendarEpisodes(
  prisma: PrismaClient,
  options: Options,
): Promise<{ today: string; episodes: CalendarEpisode[] }> {
  const now = options.now ?? Date.now();
  const today = localTime(now, options.timeZone).date;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - options.pastDays * DAY_MS);
  const shows =
    options.scope === 'following' ? await followedShows(prisma, options.userId, now) : undefined;
  if (shows && shows.length === 0) return { today, episodes: [] };

  const rows = await prisma.scheduledEpisode.findMany({
    where: {
      airDate: { gte: from },
      mediaItem: {
        type: 'SHOW',
        ...ageFilter(options.viewer),
        ...(shows && { id: { in: shows } }),
      },
    },
    orderBy: [{ airDate: 'asc' }, { seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
    include: { mediaItem: true },
    take: MAX_EPISODES,
  });

  // Which of these are in the library already.
  const itemIds = [...new Set(rows.map((r) => r.mediaItemId))];
  const present = await prisma.episode.findMany({
    where: { season: { mediaItemId: { in: itemIds } }, files: { some: {} } },
    select: { episodeNumber: true, season: { select: { seasonNumber: true, mediaItemId: true } } },
  });
  const have = new Set(
    present.map((e) => `${e.season.mediaItemId}/${e.season.seasonNumber}/${e.episodeNumber}`),
  );

  const items = new Map(rows.map((r) => [r.mediaItemId, r.mediaItem]));
  const summaries = await withProgress(prisma, options.userId, [...items.values()]);
  const byId = new Map<string, ItemSummary>(summaries.map((s) => [s.id, s]));

  const episodes = rows.flatMap((r): CalendarEpisode[] => {
    const item = byId.get(r.mediaItemId);
    if (!item) return [];
    return [
      {
        item,
        seasonNumber: r.seasonNumber,
        episodeNumber: r.episodeNumber,
        ...(r.title && { title: r.title }),
        ...(r.overview && { overview: r.overview }),
        airDate: r.airDate.toISOString().slice(0, 10),
        available: have.has(`${r.mediaItemId}/${r.seasonNumber}/${r.episodeNumber}`),
      },
    ];
  });
  return { today, episodes };
}

export function calendarList(
  prisma: PrismaClient,
  options: Omit<Options, 'pastDays'>,
): Promise<{ today: string; episodes: CalendarEpisode[] }> {
  return calendarEpisodes(prisma, { ...options, pastDays: LIST_PAST_DAYS });
}

// --- iCalendar -------------------------------------------------------------

/** TEXT values: backslash, semicolon, comma and newlines escaped (RFC 5545 3.3.11). */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets continue on the next line after a space (3.1). */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line has 75 octets, the next ones 74 after their space.
    if (size + bytes > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function icsDate(date: string): string {
  return date.replace(/-/g, '');
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** "Hell's Kitchen · S24 · A3 · Titel" */
export function eventSummary(
  e: Pick<CalendarEpisode, 'seasonNumber' | 'episodeNumber' | 'title'> & {
    show: string;
  },
): string {
  return [e.show, `S${e.seasonNumber} · A${e.episodeNumber}`, e.title].filter(Boolean).join(' · ');
}

export function renderIcs(options: {
  name: string;
  episodes: CalendarEpisode[];
  /** https://cine-vault.nl, for the link to the show. */
  baseUrl: string;
  now?: number;
}): string {
  const now = options.now ?? Date.now();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CineVault//Agenda//NL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`CineVault – ${options.name}`)}`,
    'X-WR-CALDESC:Nieuwe afleveringen van de series die je volgt',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of options.episodes) {
    const url = `${options.baseUrl}/items/${e.item.id}`;
    const description = [e.overview, url].filter(Boolean).join('\n\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.item.id}-s${e.seasonNumber}e${e.episodeNumber}@cinevault`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${icsDate(e.airDate)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(e.airDate))}`,
      `SUMMARY:${icsText(eventSummary({ ...e, show: e.item.title }))}`,
      `DESCRIPTION:${icsText(description)}`,
      `URL:${url}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** The feed for a calendar token, or undefined when the token is unknown. */
export async function calendarFeed(
  prisma: PrismaClient,
  token: string,
  options: { baseUrl: string; timeZone: string; now?: number },
): Promise<string | undefined> {
  const user = await prisma.user.findUnique({
    where: { calendarToken: token },
    select: { id: true, displayName: true, username: true, maxAge: true },
  });
  if (!user) return undefined;
  const { episodes } = await calendarEpisodes(prisma, {
    userId: user.id,
    viewer: { maxAge: user.maxAge },
    scope: 'following',
    timeZone: options.timeZone,
    pastDays: FEED_PAST_DAYS,
    ...(options.now !== undefined && { now: options.now }),
  });
  return renderIcs({
    name: user.displayName || user.username,
    episodes,
    baseUrl: options.baseUrl,
    ...(options.now !== undefined && { now: options.now }),
  });
}
