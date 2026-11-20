// What gives a notification:
// - after a scan: new episodes of followed shows, new titles recommended
//   because of what someone watched, and (admins) new titles without a match;
// - on the day a followed show's next episode airs;
// - a new login on your account;
// - (admins) the transcoder can't be reached.
//
// A show is followed by whoever has it in "Mijn lijst", or watched one of its
// episodes in the last FOLLOW_DAYS days.

import type { PrismaClient } from '../generated/prisma/client.js';
import type { NotificationService, NotifyInput } from './service.js';
import { localTime } from './time.js';

const FOLLOW_DAYS = 120;
/** "Recommended" looks at what someone watched this recently. */
const SEED_DAYS = 365;
/** At most this many "recommended" notifications per person per scan. */
const MAX_RECOMMENDED = 3;
/** "Airing today" is sent from this hour (local time). */
const AIRING_HOUR = 10;

/** Who follows these shows: Mijn lijst, or watched an episode lately. */
export async function followers(
  prisma: PrismaClient,
  showIds: string[],
  now = Date.now(),
): Promise<Map<string, Set<string>>> {
  const result = new Map(showIds.map((id) => [id, new Set<string>()]));
  if (showIds.length === 0) return result;
  const [listed, watched] = await Promise.all([
    prisma.myListEntry.findMany({
      where: { mediaItemId: { in: showIds } },
      select: { userId: true, mediaItemId: true },
    }),
    prisma.watchProgress.findMany({
      where: {
        updatedAt: { gt: new Date(now - FOLLOW_DAYS * 86_400_000) },
        mediaFile: { episode: { season: { mediaItemId: { in: showIds } } } },
      },
      distinct: ['userId', 'mediaFileId'],
      select: {
        userId: true,
        mediaFile: {
          select: { episode: { select: { season: { select: { mediaItemId: true } } } } },
        },
      },
    }),
  ]);
  for (const entry of listed) result.get(entry.mediaItemId)?.add(entry.userId);
  for (const row of watched) {
    const showId = row.mediaFile.episode?.season.mediaItemId;
    if (showId) result.get(showId)?.add(row.userId);
  }
  return result;
}

function episodeCode(season: number, episode: number): string {
  return `S${season} · A${episode}`;
}

/** "S2 · A5 · Titel", "Seizoen 3 staat klaar", "3 nieuwe afleveringen: S2 · A5-A7". */
export function newEpisodesBody(
  episodes: { seasonNumber: number; episodeNumber: number; title?: string | null }[],
): string {
  const sorted = [...episodes].sort(
    (a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
  );
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return '';
  if (sorted.length === 1) {
    const code = episodeCode(first.seasonNumber, first.episodeNumber);
    return `Nieuwe aflevering: ${first.title ? `${code} · ${first.title}` : code}`;
  }
  if (first.episodeNumber === 1 && sorted.every((e) => e.seasonNumber === first.seasonNumber)) {
    return `Seizoen ${first.seasonNumber} staat klaar: ${sorted.length} afleveringen`;
  }
  const range =
    first.seasonNumber === last.seasonNumber
      ? `${episodeCode(first.seasonNumber, first.episodeNumber)}–A${last.episodeNumber}`
      : `vanaf ${episodeCode(first.seasonNumber, first.episodeNumber)}`;
  return `${sorted.length} nieuwe afleveringen: ${range}`;
}

export interface LibraryScanned {
  libraryId: string;
  libraryName: string;
  /** When the scan of this library began: what was made since is new. */
  startedAt: Date;
  /** The library's first scan: everything is "new", so nothing is notified. */
  firstScan: boolean;
}

export class NotificationEvents {
  private transcoderDownSince: number | undefined;
  private transcoderFailures = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
    private readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** After a library was scanned (and its metadata fetched). */
  async libraryScanned(scan: LibraryScanned): Promise<number> {
    if (scan.firstScan) return 0;
    const inputs = [
      ...(await this.newEpisodes(scan)),
      ...(await this.recommended(scan)),
      ...(await this.unmatched(scan)),
    ];
    return this.notifications.notify(inputs);
  }

  private async newEpisodes(scan: LibraryScanned): Promise<NotifyInput[]> {
    // New episodes, not new files: an upgrade replaces the file of an episode that was here.
    const files = await this.prisma.mediaFile.findMany({
      where: {
        createdAt: { gte: scan.startedAt },
        episode: {
          createdAt: { gte: scan.startedAt },
          season: { seasonNumber: { gt: 0 }, mediaItem: { libraryId: scan.libraryId } },
        },
      },
      select: {
        id: true,
        episode: {
          select: {
            id: true,
            episodeNumber: true,
            title: true,
            season: {
              select: {
                seasonNumber: true,
                mediaItem: { select: { id: true, title: true } },
              },
            },
          },
        },
      },
    });
    const byShow = new Map<string, { title: string; files: typeof files }>();
    for (const file of files) {
      const show = file.episode?.season.mediaItem;
      if (!show) continue;
      const entry = byShow.get(show.id) ?? { title: show.title, files: [] };
      entry.files.push(file);
      byShow.set(show.id, entry);
    }
    const follow = await followers(this.prisma, [...byShow.keys()], this.now());
    const inputs: NotifyInput[] = [];
    for (const [showId, show] of byShow) {
      const episodes = show.files.flatMap((f) =>
        f.episode
          ? [
              {
                fileId: f.id,
                episodeId: f.episode.id,
                seasonNumber: f.episode.season.seasonNumber,
                episodeNumber: f.episode.episodeNumber,
                title: f.episode.title,
              },
            ]
          : [],
      );
      episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
      const first = episodes[0];
      if (!first) continue;
      for (const userId of follow.get(showId) ?? []) {
        inputs.push({
          userId,
          type: 'new-episodes',
          title: show.title,
          body: newEpisodesBody(episodes),
          key: `new-episodes:${first.episodeId}`,
          itemId: showId,
          fileId: first.fileId,
        });
      }
    }
    return inputs;
  }

  /**
   * New titles that TMDB recommends because of something a person watched (or
   * the other way around: the new title recommends what they watched).
   */
  private async recommended(scan: LibraryScanned): Promise<NotifyInput[]> {
    const fresh = await this.prisma.mediaItem.findMany({
      where: {
        libraryId: scan.libraryId,
        createdAt: { gte: scan.startedAt },
        metadataStatus: 'MATCHED',
        tmdbId: { not: null },
      },
      select: { id: true, type: true, title: true, tmdbId: true, recommendedTmdbIds: true },
    });
    if (fresh.length === 0) return [];
    const watched = await this.prisma.watchProgress.findMany({
      where: { updatedAt: { gt: new Date(this.now() - SEED_DAYS * 86_400_000) } },
      orderBy: { updatedAt: 'desc' },
      select: {
        userId: true,
        mediaFile: {
          select: {
            mediaItem: {
              select: { id: true, type: true, title: true, tmdbId: true, recommendedTmdbIds: true },
            },
            episode: {
              select: {
                season: {
                  select: {
                    mediaItem: {
                      select: {
                        id: true,
                        type: true,
                        title: true,
                        tmdbId: true,
                        recommendedTmdbIds: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    // Per person, the titles they watched, the latest first.
    type Seed = NonNullable<(typeof watched)[number]['mediaFile']['mediaItem']>;
    const seeds = new Map<string, Seed[]>();
    for (const row of watched) {
      const item = row.mediaFile.mediaItem ?? row.mediaFile.episode?.season.mediaItem;
      if (!item) continue;
      const list = seeds.get(row.userId) ?? [];
      if (!list.some((s) => s.id === item.id)) list.push(item);
      seeds.set(row.userId, list);
    }
    const inputs: NotifyInput[] = [];
    for (const [userId, list] of seeds) {
      let count = 0;
      for (const item of fresh) {
        if (count >= MAX_RECOMMENDED) break;
        const because = list.find(
          (seed) =>
            seed.id !== item.id &&
            seed.type === item.type &&
            ((item.tmdbId !== null && seed.recommendedTmdbIds.includes(item.tmdbId)) ||
              (seed.tmdbId !== null && item.recommendedTmdbIds.includes(seed.tmdbId))),
        );
        if (!because) continue;
        count++;
        inputs.push({
          userId,
          type: 'recommended',
          title: `Nieuw: ${item.title}`,
          body: `Omdat je ${because.title} keek. Nu in ${scan.libraryName}.`,
          key: `recommended:${item.id}`,
          itemId: item.id,
        });
      }
    }
    return inputs;
  }

  /** Admins: new titles in this scan that could not be matched. */
  private async unmatched(scan: LibraryScanned): Promise<NotifyInput[]> {
    const items = await this.prisma.mediaItem.findMany({
      where: {
        libraryId: scan.libraryId,
        createdAt: { gte: scan.startedAt },
        metadataStatus: { in: ['UNMATCHED', 'FAILED'] },
      },
      orderBy: { sortTitle: 'asc' },
      select: { id: true, title: true },
    });
    if (items.length === 0) return [];
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    const names = items.slice(0, 3).map((i) => i.title);
    const more = items.length > 3 ? ` en ${items.length - 3} meer` : '';
    return admins.map((admin) => ({
      userId: admin.id,
      type: 'admin-unmatched' as const,
      title:
        items.length === 1
          ? `Niet gematcht in ${scan.libraryName}`
          : `${items.length} titels niet gematcht in ${scan.libraryName}`,
      body: `${names.join(', ')}${more}. Kies de juiste titel onder Beheer → Aandacht nodig.`,
      key: `admin-unmatched:${items.map((i) => i.id).join(',')}`.slice(0, 200),
      path: '/attention',
    }));
  }

  /** Followed shows whose next episode airs today, from the morning on. */
  async airingToday(): Promise<number> {
    const local = localTime(this.now(), this.timeZone);
    if (local.hour < AIRING_HOUR) return 0;
    const shows = await this.prisma.mediaItem.findMany({
      where: {
        type: 'SHOW',
        nextEpisodeAirDate: new Date(`${local.date}T00:00:00Z`),
        nextEpisodeSeason: { not: null },
        nextEpisodeNumber: { not: null },
      },
      select: {
        id: true,
        title: true,
        nextEpisodeSeason: true,
        nextEpisodeNumber: true,
        nextEpisodeTitle: true,
      },
    });
    const follow = await followers(
      this.prisma,
      shows.map((s) => s.id),
      this.now(),
    );
    const inputs: NotifyInput[] = [];
    for (const show of shows) {
      const code = episodeCode(show.nextEpisodeSeason ?? 0, show.nextEpisodeNumber ?? 0);
      for (const userId of follow.get(show.id) ?? []) {
        inputs.push({
          userId,
          type: 'airing',
          title: show.title,
          body: `Vandaag verschijnt ${show.nextEpisodeTitle ? `${code} · ${show.nextEpisodeTitle}` : code}`,
          key: `airing:${show.id}:${show.nextEpisodeSeason}:${show.nextEpisodeNumber}`,
          itemId: show.id,
        });
      }
    }
    return this.notifications.notify(inputs);
  }

  /** Someone logged in on this account (a new session). */
  async newLogin(userId: string, sessionId: string, device: string): Promise<void> {
    const { hour, minute } = localTime(this.now(), this.timeZone);
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    await this.notifications.notify([
      {
        userId,
        type: 'new-login',
        title: 'Nieuwe login op je account',
        body: `Op ${device}, om ${time}. Was jij dat niet? Kies dan een nieuw wachtwoord onder Profiel.`,
        key: `new-login:${sessionId}`,
        path: '/profile',
      },
    ]);
  }

  /**
   * The transcoder's health, every few minutes. After three failures in a
   * row (about a quarter of an hour) admins hear about it, once per outage.
   */
  async transcoderChecked(ok: boolean): Promise<void> {
    if (ok) {
      this.transcoderFailures = 0;
      this.transcoderDownSince = undefined;
      return;
    }
    this.transcoderFailures++;
    this.transcoderDownSince ??= this.now();
    if (this.transcoderFailures !== 3) return;
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    await this.notifications.notify(
      admins.map((admin) => ({
        userId: admin.id,
        type: 'admin-transcoder' as const,
        title: 'Transcoder niet bereikbaar',
        body: 'Alleen direct play werkt nu. Start hem op de server met docker compose up -d transcoder.',
        key: `admin-transcoder:${this.transcoderDownSince}`,
        path: '/admin',
      })),
    );
  }
}

/** "Chrome op Windows", "de Android-app": which device a login came from. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/okhttp|CineVault/i.test(ua)) return 'de Android-app';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : undefined;
  const system = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Tizen|Web0S|SmartTV/i.test(ua)
            ? 'een tv'
            : /Linux/.test(ua)
              ? 'Linux'
              : undefined;
  if (browser && system) return `${browser} op ${system}`;
  return browser ?? system ?? 'een onbekend apparaat';
}
