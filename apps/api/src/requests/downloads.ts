// "Wordt gedownload": what Radarr and Sonarr are downloading now, per title.
// Their queue is asked at most every few seconds, however many apps ask; a
// server that doesn't answer leaves only its own titles out.

import type {
  DownloadEntry,
  DownloadProgress,
  DownloadState,
  RequestKind,
} from '@cinevault/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import { imageUrl } from '../images.js';
import type { QueueRecord, RadarrClient, SonarrClient } from './arr.js';

const CACHE_MS = 10_000;

export interface DownloadServiceOptions {
  prisma: PrismaClient;
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  log?: { warn(obj: object, msg?: string): void };
  now?: () => number;
}

/** A title in the queue, before it is matched to the library. */
interface QueuedTitle extends DownloadProgress {
  kind: RequestKind;
  tmdbId?: number;
  tvdbId?: number;
  title: string;
}

/** "01:02:03" or "1.02:03:04" → ms. */
export function timeLeftMs(value: string | undefined): number | undefined {
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(value ?? '');
  if (!match) return undefined;
  const [, days = '0', h = '0', m = '0', sec = '0'] = match;
  return (((Number(days) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(sec)) * 1000;
}

function stateOf(r: QueueRecord): { state: DownloadState; message?: string } {
  const status = (r.status ?? '').toLowerCase();
  const tracked = (r.trackedDownloadState ?? '').toLowerCase();
  const health = (r.trackedDownloadStatus ?? '').toLowerCase();
  const message =
    r.errorMessage ?? r.statusMessages?.flatMap((m) => m.messages ?? [m.title ?? ''])[0];
  if (status === 'failed' || tracked.startsWith('failed') || health === 'error') {
    return { state: 'failed', ...(message && { message }) };
  }
  if (tracked === 'importpending' || tracked === 'importing' || status === 'completed') {
    return health === 'warning' && message ? { state: 'warning', message } : { state: 'importing' };
  }
  if (health === 'warning') return { state: 'warning', ...(message && { message }) };
  if (status === 'paused') return { state: 'paused' };
  if (status === 'queued' || status === 'delay' || status === 'downloadclientunavailable') {
    return { state: 'queued' };
  }
  return { state: 'downloading' };
}

/** Which of a title's downloads says the most: a failure before a warning before progress. */
const WEIGHT: Record<DownloadState, number> = {
  failed: 5,
  warning: 4,
  downloading: 3,
  importing: 2,
  paused: 1,
  queued: 0,
};

/** The queue's records, one per title. */
export function groupQueue(kind: RequestKind, records: QueueRecord[]): QueuedTitle[] {
  const titles = new Map<string, QueuedTitle & { size: number; left: number }>();
  for (const r of records) {
    const tmdbId = kind === 'movie' ? r.movie?.tmdbId : r.series?.tmdbId;
    const tvdbId = kind === 'show' ? r.series?.tvdbId : undefined;
    const name = (kind === 'movie' ? r.movie?.title : r.series?.title) ?? r.title ?? '';
    const key = `${tmdbId ?? ''}/${tvdbId ?? ''}/${tmdbId || tvdbId ? '' : name}`;
    const { state, message } = stateOf(r);
    const size = r.size ?? 0;
    const left = r.sizeleft ?? 0;
    const time = timeLeftMs(r.timeleft);
    const title = titles.get(key) ?? {
      kind,
      ...(tmdbId && { tmdbId }),
      ...(tvdbId && { tvdbId }),
      title: name,
      state,
      progress: 0,
      size: 0,
      left: 0,
    };
    title.size += size;
    title.left += left;
    if (WEIGHT[state] > WEIGHT[title.state]) {
      title.state = state;
      if (message) title.message = message;
      else delete title.message;
    } else if (state === title.state && message && !title.message) {
      title.message = message;
    }
    if (time !== undefined) title.timeLeftMs = Math.max(title.timeLeftMs ?? 0, time);
    const e = r.episode;
    if (e?.seasonNumber !== undefined && e.episodeNumber !== undefined) {
      const episodes = (title.episodes ??= []);
      if (
        !episodes.some(
          (x) => x.seasonNumber === e.seasonNumber && x.episodeNumber === e.episodeNumber,
        )
      ) {
        episodes.push({
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          ...(e.title && { title: e.title }),
        });
      }
    }
    titles.set(key, title);
  }
  return [...titles.values()].map(({ size, left, ...title }) => ({
    ...title,
    progress: size > 0 ? Math.min(1, Math.max(0, 1 - left / size)) : 0,
    ...(size > 0 && { sizeBytes: size, leftBytes: left }),
    ...(title.episodes && {
      episodes: title.episodes.sort(
        (a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
      ),
    }),
  }));
}

export class DownloadService {
  private cached: { at: number; titles: QueuedTitle[] } | undefined;
  private loading: Promise<QueuedTitle[]> | undefined;

  constructor(private readonly options: DownloadServiceOptions) {}

  get configured(): boolean {
    return Boolean(this.options.radarr || this.options.sonarr);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async fetchQueue(): Promise<QueuedTitle[]> {
    const ask = async (kind: RequestKind, client: RadarrClient | SonarrClient | undefined) => {
      if (!client) return [];
      try {
        return groupQueue(kind, await client.queue());
      } catch (error) {
        this.options.log?.warn({ err: error, service: client.service }, 'queue not available');
        return [];
      }
    };
    const [movies, shows] = await Promise.all([
      ask('movie', this.options.radarr),
      ask('show', this.options.sonarr),
    ]);
    return [...movies, ...shows];
  }

  /** The queue per title, at most CACHE_MS old. */
  async titles(): Promise<QueuedTitle[]> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.titles;
    this.loading ??= this.fetchQueue()
      .then((titles) => {
        this.cached = { at: this.now(), titles };
        return titles;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  /**
   * Looks up titles by kind and TMDB id (and TheTVDB id, for shows). With
   * `maxWaitMs`, a slow Radarr or Sonarr counts as an empty queue this time.
   */
  async lookup(
    maxWaitMs?: number,
  ): Promise<
    (
      kind: RequestKind,
      tmdbId?: number | null,
      tvdbId?: number | null,
    ) => DownloadProgress | undefined
  > {
    let titles: QueuedTitle[] = [];
    if (this.configured) {
      const loading = this.titles().catch(() => [] as QueuedTitle[]);
      titles =
        maxWaitMs === undefined
          ? await loading
          : await Promise.race([
              loading,
              new Promise<QueuedTitle[]>((resolve) => setTimeout(() => resolve([]), maxWaitMs)),
            ]);
    }
    return (kind, tmdbId, tvdbId) => {
      const found = titles.find(
        (t) =>
          t.kind === kind && ((tmdbId && t.tmdbId === tmdbId) || (tvdbId && t.tvdbId === tvdbId)),
      );
      if (!found) return undefined;
      const { kind: _kind, tmdbId: _tmdb, tvdbId: _tvdb, title: _title, ...progress } = found;
      return progress;
    };
  }

  /** GET /downloads: the queue, with the library's title or the request it is for. */
  async list(): Promise<DownloadEntry[]> {
    if (!this.configured) return [];
    const titles = await this.titles();
    if (titles.length === 0) return [];
    const prisma = this.options.prisma;
    const typeOf = (kind: RequestKind) => (kind === 'movie' ? 'MOVIE' : 'SHOW') as 'MOVIE' | 'SHOW';
    const [items, requests] = await Promise.all([
      prisma.mediaItem.findMany({
        where: {
          OR: titles.flatMap((t) => [
            ...(t.tmdbId ? [{ type: typeOf(t.kind), tmdbId: t.tmdbId }] : []),
            ...(t.tvdbId ? [{ type: typeOf(t.kind), tvdbId: t.tvdbId }] : []),
          ]),
        },
        select: { id: true, type: true, tmdbId: true, tvdbId: true, posterPath: true },
      }),
      prisma.mediaRequest.findMany({
        where: {
          OR: titles.flatMap((t) => (t.tmdbId ? [{ kind: typeOf(t.kind), tmdbId: t.tmdbId }] : [])),
        },
        select: { id: true, kind: true, tmdbId: true, posterPath: true },
      }),
    ]);
    return titles.map(({ tvdbId, ...t }) => {
      const type = typeOf(t.kind);
      const item = items.find(
        (i) =>
          i.type === type &&
          ((t.tmdbId && i.tmdbId === t.tmdbId) || (tvdbId && i.tvdbId === tvdbId)),
      );
      const request = t.tmdbId
        ? requests.find((r) => r.kind === type && r.tmdbId === t.tmdbId)
        : undefined;
      const posterUrl = imageUrl(item?.posterPath ?? request?.posterPath ?? null);
      return {
        ...t,
        ...(posterUrl && { posterUrl }),
        ...(item && { itemId: item.id }),
        ...(request && { requestId: request.id }),
      };
    });
  }
}
