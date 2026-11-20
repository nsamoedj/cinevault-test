// "Verzoeken": someone asks for a movie or show that is not in the library; an
// admin approves it (or it goes at once: an admin's own requests, or all of
// them with "automatisch goedkeuren"), and CineVault adds it to Radarr or
// Sonarr, which look for it and download it. When it arrives (the scan after
// Sonarr/Radarr's webhook), whoever asked hears so.

import type { DownloadService } from './downloads.js';
import type {
  DiscoverSeason,
  DiscoverSeasonDetails,
  DownloadEntry,
  ArrServerInfo,
  ArrTarget,
  MediaRequestDto,
  RequestKind,
  RequestSearchResult,
  RequestParts,
  RequestsConfig,
  RequestStatus,
} from '@cinevault/shared';
import { requestPartsLabel } from '@cinevault/shared';
import type {
  MediaRequest,
  MediaRequestUser,
  Prisma,
  PrismaClient,
  User,
} from '../generated/prisma/client.js';
import { imageUrl } from '../images.js';
import type {
  RequestCandidate,
  RequestSeason,
  RequestSeasonDetails,
  TmdbProvider,
} from '../metadata/tmdb.js';
import type { NotificationService, NotifyInput } from '../notifications/service.js';
import { ArrError, type EpisodeRecord, type RadarrClient, type SonarrClient } from './arr.js';
import { episodesOf, isWholeShow, matchEpisode, mergeEpisodes, type PartEpisode } from './parts.js';

const SETTINGS_KEY = 'requests';

export class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly itemId?: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

interface StoredSettings {
  autoApprove?: boolean;
  movies?: ArrTarget;
  shows?: ArrTarget;
  anime?: ArrTarget;
}

/** What requests need from TMDB (TmdbProvider; a fake in tests). */
export type RequestTmdb = Pick<
  TmdbProvider,
  | 'searchForRequest'
  | 'requestCandidate'
  | 'tvdbId'
  | 'searchAll'
  | 'discoverList'
  | 'requestDetails'
  | 'requestSeason'
> &
  Partial<Pick<TmdbProvider, 'recommendations' | 'collection'>>;

export interface RequestServiceOptions {
  prisma: PrismaClient;
  tmdb?: RequestTmdb;
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  notifications?: NotificationService;
  /** "Wordt gedownload": the queues of Radarr and Sonarr. */
  downloads?: DownloadService;
  log?: { warn(obj: object, msg?: string): void; info(obj: object, msg?: string): void };
  /**
   * How long approving a part of a show waits for Sonarr to finish adding it
   * (default 45 s), and how long it keeps waiting in the background after
   * that (default 15 minutes).
   */
  sonarrWaitMs?: { now: number; later: number };
}

/** What sending a request to Radarr or Sonarr gave: a note, and maybe work left for later. */
interface Sent {
  reason: string | null;
  /** Runs once the request is stored as APPROVED. */
  later?: () => Promise<void>;
}

type RequestRow = MediaRequest & {
  requesters: (MediaRequestUser & { user: Pick<User, 'id' | 'displayName' | 'username'> })[];
};

const withRequesters = {
  requesters: {
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, displayName: true, username: true } } },
  },
} satisfies Prisma.MediaRequestInclude;

const KIND: Record<RequestKind, 'MOVIE' | 'SHOW'> = { movie: 'MOVIE', show: 'SHOW' };

function kindOf(kind: 'MOVIE' | 'SHOW'): RequestKind {
  return kind === 'MOVIE' ? 'movie' : 'show';
}

/** "Seizoen 2" or "S1 · A1–A3" for a part of a show; undefined for a whole title. */
function partsLabel(request: MediaRequest): string | undefined {
  if (isWholeShow(request)) return undefined;
  return requestPartsLabel({ seasons: request.seasons, episodes: episodesOf(request) });
}

/** "Breaking Bad" or "Breaking Bad (Seizoen 2)". */
function titleOf(request: MediaRequest): string {
  const parts = partsLabel(request);
  return parts ? `${request.title} (${parts})` : request.title;
}

function nameOf(user: { displayName: string; username: string }): string {
  return user.displayName || user.username;
}

/** A folder for the kind: the one named like the library ("Movies", "Series", "Anime"), else the first. */
function guessFolder(
  folders: { path: string }[],
  pattern: RegExp,
  avoid?: RegExp,
): string | undefined {
  const named = folders.find((f) =>
    pattern.test(f.path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''),
  );
  return (named ?? folders.find((f) => !avoid?.test(f.path)) ?? folders[0])?.path;
}

export class RequestService {
  private readonly prisma: PrismaClient;

  constructor(private readonly options: RequestServiceOptions) {
    this.prisma = options.prisma;
  }

  private async stored(): Promise<StoredSettings> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    if (!row) return {};
    try {
      return JSON.parse(row.value) as StoredSettings;
    } catch {
      return {};
    }
  }

  private async serverInfo(
    client: RadarrClient | SonarrClient | undefined,
  ): Promise<ArrServerInfo> {
    if (!client) return { configured: false, ok: false, rootFolders: [], qualityProfiles: [] };
    try {
      const [version, rootFolders, qualityProfiles] = await Promise.all([
        client.version(),
        client.rootFolders(),
        client.qualityProfiles(),
      ]);
      return {
        configured: true,
        ok: true,
        ...(version && { version }),
        rootFolders,
        qualityProfiles,
      };
    } catch (error) {
      return {
        configured: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rootFolders: [],
        qualityProfiles: [],
      };
    }
  }

  /** Beheer → Verzoeken: the connections, and where new titles go (saved, or guessed). */
  async config(): Promise<RequestsConfig> {
    const [stored, radarr, sonarr] = await Promise.all([
      this.stored(),
      this.serverInfo(this.options.radarr),
      this.serverInfo(this.options.sonarr),
    ]);
    const guess = (info: ArrServerInfo, pattern: RegExp, avoid?: RegExp): ArrTarget | undefined => {
      const folder = guessFolder(info.rootFolders, pattern, avoid);
      const profile = info.qualityProfiles[0];
      return folder && profile
        ? { rootFolderPath: folder, qualityProfileId: profile.id }
        : undefined;
    };
    const movies = stored.movies ?? guess(radarr, /movie|film/i);
    const shows = stored.shows ?? guess(sonarr, /series|serie|show|tv/i, /anime/i);
    const anime = stored.anime ?? guess(sonarr, /anime/i);
    return {
      radarr,
      sonarr,
      autoApprove: stored.autoApprove ?? false,
      ...(movies && { movies }),
      ...(shows && { shows }),
      ...(anime && { anime }),
    };
  }

  async saveConfig(changes: StoredSettings): Promise<RequestsConfig> {
    const value = JSON.stringify({ ...(await this.stored()), ...changes });
    await this.prisma.appSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value },
      update: { value },
    });
    return this.config();
  }

  tmdb(): RequestTmdb {
    if (!this.options.tmdb) {
      throw new RequestError(503, 'zoeken naar nieuwe titels vraagt een TMDB_API_KEY');
    }
    return this.options.tmdb;
  }

  /** Titles on TMDB, with what is already here or asked for. */
  async search(q: string, kind: RequestKind): Promise<RequestSearchResult[]> {
    return this.annotate(await this.tmdb().searchForRequest(kind === 'movie' ? 'movie' : 'tv', q));
  }

  /** TMDB's titles, with what is in the library (a link) or asked for (its status). */
  async annotate(found: RequestCandidate[]): Promise<RequestSearchResult[]> {
    const typeOf = (c: RequestCandidate): 'MOVIE' | 'SHOW' =>
      c.kind === 'movie' ? 'MOVIE' : 'SHOW';
    const where = found.map((c) => ({ type: typeOf(c), tmdbId: c.tmdbId }));
    const [items, requests] =
      where.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.mediaItem.findMany({
              where: { OR: where },
              select: { id: true, type: true, tmdbId: true },
            }),
            this.prisma.mediaRequest.findMany({
              where: { OR: where.map((w) => ({ kind: w.type, tmdbId: w.tmdbId })) },
              select: {
                id: true,
                kind: true,
                tmdbId: true,
                status: true,
                seasons: true,
                episodes: true,
              },
              orderBy: { createdAt: 'desc' },
            }),
          ]);
    const downloading = await this.downloading();
    return found.map((c) => {
      const type = typeOf(c);
      const download = downloading(c.kind === 'movie' ? 'movie' : 'show', c.tmdbId);
      const posterUrl = imageUrl(c.posterRef);
      const backdropUrl = imageUrl(c.backdropRef);
      const itemId = items.find((i) => i.type === type && i.tmdbId === c.tmdbId)?.id;
      // The card says "aangevraagd" only for the whole title; parts show on its page.
      const request = requests.find(
        (r) => r.kind === type && r.tmdbId === c.tmdbId && isWholeShow(r),
      );
      return {
        kind: c.kind === 'movie' ? 'movie' : 'show',
        tmdbId: c.tmdbId,
        title: c.title,
        ...(c.year && { year: c.year }),
        ...(c.releaseDate && { releaseDate: c.releaseDate }),
        ...(c.overview && { overview: c.overview }),
        ...(posterUrl && { posterUrl }),
        ...(backdropUrl && { backdropUrl }),
        ...(c.rating && { rating: Math.round(c.rating * 10) / 10 }),
        anime: c.anime,
        ...(itemId && { itemId }),
        ...(request && { request: { id: request.id, status: request.status as RequestStatus } }),
        ...(download && { download }),
      };
    });
  }

  /** Requests for a show that wait or are with Sonarr. */
  private openShowRequests(tmdbId: number): Promise<MediaRequest[]> {
    return this.prisma.mediaRequest.findMany({
      where: { kind: 'SHOW', tmdbId, status: { in: ['PENDING', 'APPROVED'] } },
    });
  }

  /** A show's seasons in "Ontdekken": how much of each is here, and whether it is asked for. */
  async seasonsHere(
    tmdbId: number,
    itemId: string | undefined,
    seasons: RequestSeason[],
  ): Promise<DiscoverSeason[]> {
    const [local, open] = await Promise.all([
      itemId ? this.localEpisodes(itemId) : Promise.resolve([]),
      this.openShowRequests(tmdbId),
    ]);
    return seasons.map((season) => {
      const posterUrl = imageUrl(season.posterRef);
      return {
        seasonNumber: season.seasonNumber,
        ...(season.name && { name: season.name }),
        episodeCount: season.episodeCount,
        ...(season.airDate && { airDate: season.airDate }),
        ...(posterUrl && { posterUrl }),
        inLibrary: local.filter((e) => e.seasonNumber === season.seasonNumber).length,
        requested: open.some((r) => isWholeShow(r) || r.seasons.includes(season.seasonNumber)),
      };
    });
  }

  /** A season's episodes in "Ontdekken": here, asked for, or not out yet. */
  async seasonHere(tmdbId: number, season: RequestSeasonDetails): Promise<DiscoverSeasonDetails> {
    const item = await this.prisma.mediaItem.findFirst({
      where: { type: 'SHOW', tmdbId },
      select: { id: true },
    });
    const [local, open] = await Promise.all([
      item ? this.localEpisodes(item.id) : Promise.resolve([]),
      this.openShowRequests(tmdbId),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    return {
      seasonNumber: season.seasonNumber,
      ...(season.name && { name: season.name }),
      episodes: season.episodes.map((e) => {
        const stillUrl = imageUrl(e.stillRef);
        return {
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          ...(e.title && { title: e.title }),
          ...(e.airDate && { airDate: e.airDate }),
          ...(e.overview && { overview: e.overview }),
          ...(stillUrl && { stillUrl }),
          inLibrary: Boolean(matchEpisode(e, local)),
          requested: open.some(
            (r) =>
              isWholeShow(r) ||
              r.seasons.includes(e.seasonNumber) ||
              episodesOf(r).some(
                (x) => x.seasonNumber === e.seasonNumber && x.episodeNumber === e.episodeNumber,
              ),
          ),
          upcoming: !e.airDate || e.airDate > today,
        };
      }),
    };
  }

  /** What Radarr and Sonarr are downloading (not waiting long for them). */
  private async downloading() {
    const lookup = await this.options.downloads?.lookup(2000);
    return lookup ?? (() => undefined);
  }

  /** GET /downloads: the queues of Radarr and Sonarr, per title. */
  async downloads(): Promise<DownloadEntry[]> {
    return (await this.options.downloads?.list()) ?? [];
  }

  private async toDto(rows: RequestRow[]): Promise<MediaRequestDto[]> {
    const items = await this.prisma.mediaItem.findMany({
      where: {
        OR: rows.map((r) => ({ type: r.kind, tmdbId: r.tmdbId })),
      },
      select: { id: true, type: true, tmdbId: true },
    });
    const itemOf = (r: RequestRow) =>
      items.find((i) => i.type === r.kind && i.tmdbId === r.tmdbId)?.id;
    const downloading = await this.downloading();
    return rows.map((r) => {
      const posterUrl = imageUrl(r.posterPath);
      const itemId = itemOf(r);
      const download = downloading(kindOf(r.kind), r.tmdbId);
      return {
        id: r.id,
        kind: kindOf(r.kind),
        tmdbId: r.tmdbId,
        title: r.title,
        ...(r.year && { year: r.year }),
        ...(r.overview && { overview: r.overview }),
        ...(posterUrl && { posterUrl }),
        anime: r.anime,
        ...(r.seasons.length > 0 && { seasons: r.seasons }),
        ...(episodesOf(r).some((e) => !r.seasons.includes(e.seasonNumber)) && {
          episodes: episodesOf(r)
            .filter((e) => !r.seasons.includes(e.seasonNumber))
            .map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber })),
        }),
        status: r.status as RequestStatus,
        requestedBy: r.requesters.map((q) => ({ id: q.user.id, displayName: nameOf(q.user) })),
        createdAt: r.createdAt.toISOString(),
        ...(r.decidedAt && { decidedAt: r.decidedAt.toISOString() }),
        ...(r.decidedBy && { decidedBy: r.decidedBy }),
        ...(r.reason && { reason: r.reason }),
        ...(itemId && { itemId }),
        ...(download && { download }),
      };
    });
  }

  private async one(id: string): Promise<MediaRequestDto> {
    const row = await this.prisma.mediaRequest.findUnique({
      where: { id },
      include: withRequesters,
    });
    if (!row) throw new RequestError(404, 'verzoek niet gevonden');
    const [dto] = await this.toDto([row]);
    return dto as MediaRequestDto;
  }

  /** Everyone in the household sees all requests: waiting ones first, then the newest. */
  async list(): Promise<MediaRequestDto[]> {
    const rows = await this.prisma.mediaRequest.findMany({
      include: withRequesters,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const order: Record<string, number> = {
      PENDING: 0,
      FAILED: 1,
      APPROVED: 2,
      AVAILABLE: 3,
      DECLINED: 4,
    };
    rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    return this.toDto(rows);
  }

  /**
   * Someone asks for a title, or for some seasons or episodes of a show.
   * Asking for what is asked for already adds them to that request; parts
   * asked while an earlier part still waits are added to it.
   */
  async create(
    user: { id: string; role: 'ADMIN' | 'USER' },
    body: { kind: RequestKind; tmdbId: number; anime?: boolean } & RequestParts,
  ): Promise<MediaRequestDto> {
    const type = KIND[body.kind];
    const parts =
      body.kind === 'show' && (body.seasons?.length || body.episodes?.length)
        ? {
            seasons: [...new Set(body.seasons ?? [])].sort((a, b) => a - b),
            episodes: body.episodes ?? [],
          }
        : undefined;
    const item = await this.prisma.mediaItem.findFirst({
      where: { type, tmdbId: body.tmdbId },
      select: { id: true },
    });
    if (item && !parts) {
      throw new RequestError(409, 'deze titel staat al in de bibliotheek', item.id);
    }
    const existing = await this.prisma.mediaRequest.findMany({
      where: { kind: type, tmdbId: body.tmdbId },
      orderBy: { createdAt: 'asc' },
    });
    const person = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    let request: MediaRequest | undefined;
    if (!parts) {
      request = existing.find((r) => isWholeShow(r));
      if (request?.status === 'AVAILABLE') {
        throw new RequestError(409, 'deze titel staat al in de bibliotheek');
      }
      if (request?.status === 'DECLINED') {
        // Asked again after a "no": back to the admins.
        request = await this.prisma.mediaRequest.update({
          where: { id: request.id },
          data: { status: 'PENDING', reason: null, decidedAt: null, decidedBy: null },
        });
      }
      request ??= await this.newRequest(body, {});
    } else {
      const wanted = await this.wantedEpisodes(body.tmdbId, parts);
      const local = item ? await this.localEpisodes(item.id) : [];
      const missing = wanted.filter((w) => !matchEpisode(w, local));
      if (missing.length === 0) {
        throw new RequestError(409, 'deze afleveringen staan al in de bibliotheek', item?.id);
      }
      const open = existing.filter((r) => r.status === 'PENDING' || r.status === 'APPROVED');
      const covers = (r: MediaRequest) =>
        isWholeShow(r) ||
        (parts.seasons.every((season) => r.seasons.includes(season)) &&
          missing.every((m) => episodesOf(r).some((e) => matchEpisode(m, [e]))));
      request = open.find(covers);
      if (!request) {
        const waiting = open.find((r) => r.status === 'PENDING' && !isWholeShow(r));
        request = waiting
          ? await this.prisma.mediaRequest.update({
              where: { id: waiting.id },
              data: {
                seasons: [...new Set([...waiting.seasons, ...parts.seasons])].sort((a, b) => a - b),
                episodes: mergeEpisodes(
                  episodesOf(waiting),
                  missing,
                ) as unknown as Prisma.InputJsonValue,
              },
            })
          : await this.newRequest(body, { seasons: parts.seasons, episodes: missing });
      }
    }
    await this.prisma.mediaRequestUser.upsert({
      where: { requestId_userId: { requestId: request.id, userId: user.id } },
      create: { requestId: request.id, userId: user.id },
      update: {},
    });

    if (request.status === 'PENDING') {
      const { autoApprove } = await this.stored();
      if (user.role === 'ADMIN' || autoApprove) {
        return this.approve(request.id, { id: person.id, name: nameOf(person) });
      }
      await this.notifyAdmins(request, nameOf(person), person.id);
    }
    return this.one(request.id);
  }

  /** A new request, with the title's card from TMDB. */
  private async newRequest(
    body: { kind: RequestKind; tmdbId: number; anime?: boolean },
    parts: { seasons?: number[]; episodes?: PartEpisode[] },
  ): Promise<MediaRequest> {
    const candidate = await this.tmdb().requestCandidate(
      body.kind === 'movie' ? 'movie' : 'tv',
      body.tmdbId,
    );
    if (!candidate) throw new RequestError(404, 'TMDB kent deze titel niet');
    return this.prisma.mediaRequest.create({
      data: {
        kind: KIND[body.kind],
        tmdbId: body.tmdbId,
        title: candidate.title,
        year: candidate.year ?? null,
        overview: candidate.overview ?? null,
        posterPath: candidate.posterRef ?? null,
        anime: body.kind === 'show' && (body.anime ?? candidate.anime),
        ...(parts.seasons && { seasons: parts.seasons }),
        ...(parts.episodes && { episodes: parts.episodes as unknown as Prisma.InputJsonValue }),
      },
    });
  }

  /**
   * The episodes a part covers, with their air dates (TMDB): of a whole season
   * those that are out (the rest Sonarr follows anyway; the first, when none
   * is out yet), and the single ones asked for.
   */
  private async wantedEpisodes(
    tmdbId: number,
    parts: { seasons: number[]; episodes: { seasonNumber: number; episodeNumber: number }[] },
  ): Promise<PartEpisode[]> {
    const today = new Date().toISOString().slice(0, 10);
    const numbers = [...new Set([...parts.seasons, ...parts.episodes.map((e) => e.seasonNumber)])];
    const seasons = new Map(
      await Promise.all(
        numbers.map(async (n) => [n, await this.tmdb().requestSeason(tmdbId, n)] as const),
      ),
    );
    const wanted: PartEpisode[] = [];
    const add = (e: { seasonNumber: number; episodeNumber: number; airDate?: string }) =>
      wanted.push({
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        ...(e.airDate && { airDate: e.airDate }),
      });
    for (const n of parts.seasons) {
      const episodes = seasons.get(n)?.episodes ?? [];
      if (episodes.length === 0) throw new RequestError(404, `TMDB kent seizoen ${n} niet`);
      const out = episodes.filter((e) => e.airDate && e.airDate <= today);
      for (const e of out.length > 0 ? out : episodes.slice(0, 1)) add(e);
    }
    for (const asked of parts.episodes) {
      if (parts.seasons.includes(asked.seasonNumber)) continue;
      const found = seasons
        .get(asked.seasonNumber)
        ?.episodes.find((e) => e.episodeNumber === asked.episodeNumber);
      if (!found) {
        throw new RequestError(
          404,
          `TMDB kent S${asked.seasonNumber} · A${asked.episodeNumber} niet`,
        );
      }
      add(found);
    }
    return mergeEpisodes([], wanted);
  }

  /** The episodes of a show in the library (with a file). */
  private async localEpisodes(itemId: string): Promise<PartEpisode[]> {
    const episodes = await this.prisma.episode.findMany({
      where: { season: { mediaItemId: itemId }, files: { some: {} } },
      select: { episodeNumber: true, airDate: true, season: { select: { seasonNumber: true } } },
    });
    return episodes.map((e) => ({
      seasonNumber: e.season.seasonNumber,
      episodeNumber: e.episodeNumber,
      ...(e.airDate && { airDate: e.airDate.toISOString().slice(0, 10) }),
    }));
  }

  private async notifyAdmins(request: MediaRequest, who: string, except: string): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    const parts = partsLabel(request);
    const what =
      request.kind === 'MOVIE'
        ? 'deze film'
        : parts
          ? `${parts.replace(/^Seizoen/, 'seizoen')} van deze serie`
          : 'deze serie';
    await this.options.notifications?.notify(
      admins
        .filter((a) => a.id !== except)
        .map((admin) => ({
          userId: admin.id,
          type: 'request-new' as const,
          title: `Nieuw verzoek: ${request.title}${request.year ? ` (${request.year})` : ''}${partsLabel(request) ? ` · ${partsLabel(request)}` : ''}`,
          body: `${who} vraagt ${what} aan. Keur het goed of wijs het af onder Verzoeken.`,
          key: `request-new:${request.id}:${except}`,
          path: '/requests',
        })),
    );
  }

  private async notifyRequesters(
    requestId: string,
    except: string | undefined,
    message: Omit<NotifyInput, 'userId' | 'type'>,
  ): Promise<void> {
    const requesters = await this.prisma.mediaRequestUser.findMany({ where: { requestId } });
    await this.options.notifications?.notify(
      requesters
        .filter((r) => r.userId !== except)
        .map((r) => ({ ...message, userId: r.userId, type: 'request-update' as const })),
    );
  }

  /** Sends it to Radarr or Sonarr. A refusal there is FAILED, with what they said. */
  async approve(
    id: string,
    admin: { id: string; name: string },
    options: { anime?: boolean } = {},
  ): Promise<MediaRequestDto> {
    let request = await this.prisma.mediaRequest.findUnique({ where: { id } });
    if (!request) throw new RequestError(404, 'verzoek niet gevonden');
    if (request.status === 'AVAILABLE') return this.one(id);
    if (options.anime !== undefined && request.kind === 'SHOW') {
      request = await this.prisma.mediaRequest.update({
        where: { id },
        data: { anime: options.anime },
      });
    }
    let status: 'APPROVED' | 'FAILED' = 'APPROVED';
    let reason: string | null;
    let later: Sent['later'];
    try {
      ({ reason, later } = await this.send(request));
    } catch (error) {
      status = 'FAILED';
      reason =
        error instanceof ArrError || error instanceof RequestError
          ? error.message
          : `onbekende fout: ${error instanceof Error ? error.message : String(error)}`;
      this.options.log?.warn({ err: error, title: request.title }, 'request could not be added');
    }
    await this.prisma.mediaRequest.update({
      where: { id },
      data: { status, reason, decidedAt: new Date(), decidedBy: admin.name },
    });
    if (later) this.track(later());
    if (status === 'APPROVED') {
      const service = request.kind === 'MOVIE' ? 'Radarr' : 'Sonarr';
      const parts = partsLabel(request);
      await this.notifyRequesters(id, admin.id, {
        title: `Verzoek goedgekeurd: ${titleOf(request)}`,
        body: `${service} zoekt ${request.kind === 'MOVIE' ? 'de film' : parts ? 'de afleveringen' : 'de serie'} nu. Je krijgt een melding als ${parts ? 'ze klaarstaan' : 'hij klaarstaat'}.`,
        key: `request-approved:${id}`,
        path: '/requests',
      });
    }
    // Maybe it was in the library already (added by hand, or Radarr had it).
    await this.checkAvailable();
    return this.one(id);
  }

  /** Adds the title; the note says when Radarr/Sonarr had it already. */
  private async send(request: MediaRequest): Promise<Sent> {
    const config = await this.config();
    if (request.kind === 'MOVIE') {
      const radarr = this.options.radarr;
      if (!radarr) throw new RequestError(503, 'Radarr is niet ingesteld (RADARR_API_KEY)');
      if (!config.movies)
        throw new RequestError(503, 'kies onder Beheer → Verzoeken een map voor films');
      const movie = await radarr.lookup(request.tmdbId);
      if (movie.id) return { reason: 'stond al in Radarr' };
      await radarr.add(movie, config.movies);
      return { reason: null };
    }
    const sonarr = this.options.sonarr;
    if (!sonarr) throw new RequestError(503, 'Sonarr is niet ingesteld (SONARR_API_KEY)');
    const target = request.anime ? (config.anime ?? config.shows) : config.shows;
    if (!target) throw new RequestError(503, 'kies onder Beheer → Verzoeken een map voor series');
    const tvdbId = await this.tmdb().tvdbId(request.tmdbId);
    if (!tvdbId) {
      throw new RequestError(
        422,
        'TheTVDB kent deze serie niet, dus Sonarr kan hem niet toevoegen',
      );
    }
    const show = await sonarr.lookup(tvdbId);
    if (!show) throw new RequestError(422, 'Sonarr vindt deze serie niet');
    if (isWholeShow(request)) {
      if (show.id) return { reason: 'stond al in Sonarr' };
      await sonarr.add(show, target, request.anime);
      return { reason: null };
    }
    // A part: the show in Sonarr (without following anything), then only these.
    const series = show.id ? show : await sonarr.addUnmonitored(show, target, request.anime);
    if (typeof series.id !== 'number') throw new RequestError(502, 'Sonarr gaf de serie geen id');
    const seriesId = series.id;
    const wait = this.options.sonarrWaitMs ?? { now: 45_000, later: 15 * 60_000 };
    const episodes = await sonarr.whenAdded(seriesId, wait.now);
    if (episodes) return { reason: await this.followParts(request, seriesId, episodes, !!show.id) };
    // A big show takes Sonarr longer: follow the episodes once it is done.
    return {
      reason: 'Sonarr voegt de serie nog toe; de afleveringen worden gevolgd zodra dat klaar is',
      later: async () => {
        let reason: string | null;
        let status: 'APPROVED' | 'FAILED' = 'APPROVED';
        try {
          const done = await sonarr.whenAdded(seriesId, wait.later);
          if (!done)
            throw new RequestError(504, 'Sonarr was na 15 minuten nog niet klaar met toevoegen');
          reason = await this.followParts(request, seriesId, done, false);
        } catch (error) {
          status = 'FAILED';
          reason = error instanceof Error ? error.message : String(error);
          this.options.log?.warn(
            { err: error, title: request.title },
            'request could not be followed',
          );
        }
        // Unless an admin did something else with it meanwhile.
        await this.prisma.mediaRequest.updateMany({
          where: { id: request.id, status: 'APPROVED' },
          data: { status, reason },
        });
      },
    };
  }

  /**
   * Has Sonarr follow and search the episodes a part covers, and checks
   * that it does; returns the note for the request.
   */
  private async followParts(
    request: MediaRequest,
    seriesId: number,
    all: EpisodeRecord[],
    existed: boolean,
  ): Promise<string | null> {
    const sonarr = this.options.sonarr as SonarrClient;
    const episodes = all.filter((e) => e.seasonNumber > 0);
    const ids = new Set<number>();
    const seasons = new Set<number>();
    for (const wanted of episodesOf(request)) {
      const found = matchEpisode(wanted, episodes);
      if (!found) continue;
      ids.add(found.id);
      if (request.seasons.includes(wanted.seasonNumber)) seasons.add(found.seasonNumber);
    }
    if (ids.size === 0) throw new RequestError(422, 'Sonarr kent deze afleveringen (nog) niet');
    await sonarr.monitorParts(seriesId, [...seasons], [...ids]);
    // Sonarr answers before it has saved everything at times: once more if some aren't followed.
    let followed = await sonarr.monitored(seriesId, [...ids]);
    if (followed.size < ids.size) {
      await sonarr.monitorParts(seriesId, [...seasons], [...ids]);
      followed = await sonarr.monitored(seriesId, [...ids]);
    }
    if (followed.size < ids.size) {
      throw new RequestError(
        502,
        `Sonarr volgt ${ids.size - followed.size} van de ${ids.size} afleveringen niet`,
      );
    }
    const missed = episodesOf(request).length - ids.size;
    const notes = [
      ...(existed ? ['stond al in Sonarr; deze afleveringen worden nu gevolgd'] : []),
      ...(missed > 0 ? [`${missed} aflevering(en) kent Sonarr niet`] : []),
    ];
    return notes.length ? notes.join('; ') : null;
  }

  /** Work that goes on after answering (tests wait for it with `settled`). */
  private readonly running = new Set<Promise<void>>();

  private track(work: Promise<void>): void {
    const done = work
      .catch((error: unknown) => this.options.log?.warn({ err: error }, 'request follow-up failed'))
      .finally(() => this.running.delete(done));
    this.running.add(done);
  }

  /** Waits for what approving still does in the background. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  async decline(
    id: string,
    admin: { id: string; name: string },
    reason?: string,
  ): Promise<MediaRequestDto> {
    const request = await this.prisma.mediaRequest.findUnique({ where: { id } });
    if (!request) throw new RequestError(404, 'verzoek niet gevonden');
    const decidedAt = new Date();
    await this.prisma.mediaRequest.update({
      where: { id },
      data: { status: 'DECLINED', reason: reason ?? null, decidedAt, decidedBy: admin.name },
    });
    await this.notifyRequesters(id, admin.id, {
      title: `Verzoek afgewezen: ${titleOf(request)}`,
      body: reason ? `${admin.name}: ${reason}` : `${admin.name} heeft het verzoek afgewezen.`,
      key: `request-declined:${id}:${decidedAt.getTime()}`,
      path: '/requests',
    });
    return this.one(id);
  }

  /** Your own request while it waits; admins any. With others still asking, only you leave it. */
  async remove(id: string, user: { id: string; role: 'ADMIN' | 'USER' }): Promise<void> {
    const request = await this.prisma.mediaRequest.findUnique({
      where: { id },
      include: { requesters: true },
    });
    if (!request) throw new RequestError(404, 'verzoek niet gevonden');
    if (user.role === 'ADMIN') {
      await this.prisma.mediaRequest.delete({ where: { id } });
      return;
    }
    if (!request.requesters.some((r) => r.userId === user.id)) {
      throw new RequestError(403, 'dit is niet jouw verzoek');
    }
    if (request.status !== 'PENDING') {
      throw new RequestError(409, 'alleen een verzoek dat nog wacht, kun je intrekken');
    }
    if (request.requesters.length > 1) {
      await this.prisma.mediaRequestUser.delete({
        where: { requestId_userId: { requestId: id, userId: user.id } },
      });
    } else {
      await this.prisma.mediaRequest.delete({ where: { id } });
    }
  }

  /** Requests whose title is in the library now: AVAILABLE, and whoever asked hears so. */
  async checkAvailable(): Promise<number> {
    const open = await this.prisma.mediaRequest.findMany({
      where: { status: { in: ['APPROVED', 'PENDING', 'FAILED'] } },
    });
    if (open.length === 0) return 0;
    const items = await this.prisma.mediaItem.findMany({
      where: { OR: open.map((r) => ({ type: r.kind, tmdbId: r.tmdbId })) },
      select: { id: true, type: true, tmdbId: true, title: true },
    });
    let count = 0;
    for (const request of open) {
      const item = items.find((i) => i.type === request.kind && i.tmdbId === request.tmdbId);
      if (!item) continue;
      // A part: once every episode it covers is here.
      if (!isWholeShow(request)) {
        const local = await this.localEpisodes(item.id);
        if (!episodesOf(request).every((wanted) => matchEpisode(wanted, local))) continue;
      }
      count++;
      await this.prisma.mediaRequest.update({
        where: { id: request.id },
        data: { status: 'AVAILABLE', availableAt: new Date() },
      });
      // In their Mijn lijst: there to find, and a show's next episodes notify them.
      const requesters = await this.prisma.mediaRequestUser.findMany({
        where: { requestId: request.id },
        select: { userId: true },
      });
      await this.prisma.myListEntry.createMany({
        data: requesters.map((r) => ({ userId: r.userId, mediaItemId: item.id })),
        skipDuplicates: true,
      });
      const parts = partsLabel(request);
      await this.notifyRequesters(request.id, undefined, {
        title: `Staat klaar: ${parts ? `${item.title} (${parts})` : item.title}`,
        body: parts
          ? 'De afleveringen die je aanvroeg, staan in de bibliotheek. De serie staat in Mijn lijst.'
          : request.kind === 'MOVIE'
            ? 'De film die je aanvroeg, staat in de bibliotheek en in Mijn lijst.'
            : 'De serie die je aanvroeg, staat in de bibliotheek en in Mijn lijst. Van nieuwe afleveringen krijg je een melding.',
        key: `request-available:${request.id}`,
        itemId: item.id,
      });
    }
    return count;
  }
}
