// Radarr and Sonarr (API v3, also used by Sonarr v4): what CineVault needs to
// add a title they then look for and download, and to have them remove one
// (CineVault itself never writes in the media folders).

export type FetchFn = typeof fetch;

export class ArrError extends Error {
  constructor(
    readonly service: 'radarr' | 'sonarr',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ArrError';
  }
}

export interface ArrOptions {
  /** e.g. http://host.docker.internal:7878 */
  url: string;
  apiKey: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Between two looks while Sonarr fills in a show it just added (tests: 0). */
  pollMs?: number;
}

export interface RootFolder {
  path: string;
  freeSpace?: number;
}

export interface QualityProfile {
  id: number;
  name: string;
}

/** What Radarr/Sonarr say about a title they know (lookup) or have. */
export interface ArrTitle {
  id?: number;
  title: string;
  tmdbId?: number;
  tvdbId?: number;
  [key: string]: unknown;
}

/** A file Sonarr has for an episode (GET /episodefile). */
export interface EpisodeFileRecord {
  id: number;
  seasonNumber?: number;
  /** Relative to the show's folder, e.g. "Season 1/Show - S01E01.mkv". */
  relativePath?: string;
  /** As Sonarr sees it, e.g. "D:\\Series\\Show\\Season 1\\…". */
  path?: string;
  size?: number;
}

export interface EpisodeRecord {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeFileId?: number;
  monitored?: boolean;
  /** YYYY-MM-DD, as Sonarr knows it. */
  airDate?: string;
}

/** One download in the queue of Radarr or Sonarr (GET /queue). */
export interface QueueRecord {
  title?: string;
  size?: number;
  sizeleft?: number;
  /** "HH:MM:SS" or "D.HH:MM:SS". */
  timeleft?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  movie?: { tmdbId?: number; title?: string };
  series?: { tmdbId?: number; tvdbId?: number; title?: string };
  episode?: { seasonNumber?: number; episodeNumber?: number; title?: string };
}

class ArrClient {
  private readonly base: string;

  constructor(
    readonly service: 'radarr' | 'sonarr',
    protected readonly options: ArrOptions,
  ) {
    this.base = options.url.replace(/\/+$/, '');
  }

  protected async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fetchFn = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(`${this.base}/api/v3${path}`, {
        method,
        headers: {
          'X-Api-Key': this.options.apiKey,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new ArrError(
        this.service,
        `${this.label} is niet bereikbaar op ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401) {
      throw new ArrError(this.service, `${this.label} weigert de API-key`, 401);
    }
    if (!response.ok) {
      throw new ArrError(
        this.service,
        `${this.label}: ${await errorText(response)}`,
        response.status,
      );
    }
    // A DELETE answers 200 with an empty body.
    const text = response.status === 204 ? '' : await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get label(): string {
    return this.service === 'radarr' ? 'Radarr' : 'Sonarr';
  }

  /** What Radarr or Sonarr itself says is wrong (System → Status → Health). */
  async issues(): Promise<{ type: string; message: string }[]> {
    const list = await this.call<{ type?: string; message?: string }[]>('GET', '/health');
    return (Array.isArray(list) ? list : [])
      .filter((i) => typeof i.message === 'string')
      .map((i) => ({ type: i.type ?? 'warning', message: i.message as string }));
  }

  async version(): Promise<string | undefined> {
    return (await this.call<{ version?: string }>('GET', '/system/status')).version;
  }

  async rootFolders(): Promise<RootFolder[]> {
    const folders = await this.call<{ path: string; freeSpace?: number }[]>('GET', '/rootfolder');
    return folders.map((f) => ({
      path: f.path,
      ...(typeof f.freeSpace === 'number' && { freeSpace: f.freeSpace }),
    }));
  }

  /** What is being downloaded now, with the title it is for. */
  protected async queueOf(include: string): Promise<QueueRecord[]> {
    const page = await this.call<{ records?: QueueRecord[] } | QueueRecord[]>(
      'GET',
      `/queue?page=1&pageSize=200&${include}`,
    );
    return Array.isArray(page) ? page : (page.records ?? []);
  }

  async qualityProfiles(): Promise<QualityProfile[]> {
    const profiles = await this.call<{ id: number; name: string }[]>('GET', '/qualityprofile');
    return profiles.map((p) => ({ id: p.id, name: p.name }));
  }
}

/** Radarr's messages are a list of validation errors, or { message }. */
async function errorText(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  try {
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data)) {
      const messages = data
        .map((e) => (e as { errorMessage?: string }).errorMessage)
        .filter(Boolean);
      if (messages.length > 0) return messages.join('; ');
    }
    const message = (data as { message?: string }).message;
    if (message) return message;
  } catch {
    // Not JSON.
  }
  return raw.slice(0, 200) || `HTTP ${response.status}`;
}

export class RadarrClient extends ArrClient {
  constructor(options: ArrOptions) {
    super('radarr', options);
  }

  /** The movies Radarr has, by TMDB id. */
  async movies(): Promise<ArrTitle[]> {
    return this.call<ArrTitle[]>('GET', '/movie');
  }

  async lookup(tmdbId: number): Promise<ArrTitle> {
    return this.call<ArrTitle>('GET', `/movie/lookup/tmdb?tmdbId=${tmdbId}`);
  }

  /** Removes the movie from Radarr, and its folder and files from the disk. */
  async remove(id: number): Promise<void> {
    await this.call<void>('DELETE', `/movie/${id}?deleteFiles=true&addImportExclusion=false`);
  }

  async queue(): Promise<QueueRecord[]> {
    return this.queueOf('includeMovie=true');
  }

  /** Adds the movie and has Radarr search for it. */
  async add(movie: ArrTitle, target: { rootFolderPath: string; qualityProfileId: number }) {
    return this.call<ArrTitle>('POST', '/movie', {
      ...movie,
      rootFolderPath: target.rootFolderPath,
      qualityProfileId: target.qualityProfileId,
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: true },
    });
  }
}

export class SonarrClient extends ArrClient {
  constructor(options: ArrOptions) {
    super('sonarr', options);
  }

  async series(): Promise<ArrTitle[]> {
    return this.call<ArrTitle[]>('GET', '/series');
  }

  async queue(): Promise<QueueRecord[]> {
    return this.queueOf('includeSeries=true&includeEpisode=true');
  }

  async episodeFiles(seriesId: number): Promise<EpisodeFileRecord[]> {
    return this.call<EpisodeFileRecord[]>('GET', `/episodefile?seriesId=${seriesId}`);
  }

  async episodes(seriesId: number): Promise<EpisodeRecord[]> {
    return this.call<EpisodeRecord[]>('GET', `/episode?seriesId=${seriesId}`);
  }

  /** Sonarr then doesn't look for these episodes again. */
  async unmonitor(episodeIds: number[]): Promise<void> {
    if (episodeIds.length === 0) return;
    await this.call<void>('PUT', '/episode/monitor', { episodeIds, monitored: false });
  }

  /** Deletes the file from the disk; the episode stays in Sonarr. */
  async removeEpisodeFile(id: number): Promise<void> {
    await this.call<void>('DELETE', `/episodefile/${id}`);
  }

  /** Removes the show from Sonarr, and its folder and files from the disk. */
  async remove(id: number): Promise<void> {
    await this.call<void>('DELETE', `/series/${id}?deleteFiles=true&addImportListExclusion=false`);
  }

  async lookup(tvdbId: number): Promise<ArrTitle | undefined> {
    const found = await this.call<ArrTitle[]>(
      'GET',
      `/series/lookup?term=${encodeURIComponent(`tvdb:${tvdbId}`)}`,
    );
    return found.find((s) => s.tvdbId === tvdbId) ?? found[0];
  }

  /** Sonarr v3 needs a language profile; v4 has none (and answers 404 or an empty list). */
  async languageProfileId(): Promise<number | undefined> {
    try {
      const profiles = await this.call<{ id: number }[]>('GET', '/languageprofile');
      return profiles[0]?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Adds the show without following anything yet, for a request of some
   * seasons or episodes (monitorParts follows those).
   */
  async addUnmonitored(
    show: ArrTitle,
    target: { rootFolderPath: string; qualityProfileId: number },
    anime: boolean,
  ): Promise<ArrTitle> {
    const languageProfileId = await this.languageProfileId();
    const seasons = Array.isArray(show.seasons)
      ? (show.seasons as { seasonNumber: number }[]).map((season) => ({
          ...season,
          monitored: false,
        }))
      : [];
    return this.call<ArrTitle>('POST', '/series', {
      ...show,
      rootFolderPath: target.rootFolderPath,
      qualityProfileId: target.qualityProfileId,
      ...(languageProfileId && { languageProfileId }),
      seriesType: anime ? 'anime' : 'standard',
      seasonFolder: true,
      monitored: true,
      seasons,
      addOptions: {
        monitor: 'none',
        searchForMissingEpisodes: false,
        searchForCutoffUnmetEpisodes: false,
      },
    });
  }

  /**
   * The episodes of a show, once Sonarr is done adding it; undefined if it
   * isn't within `waitMs`.
   *
   * After POST /series Sonarr fills in the episodes, scans the folder, and
   * only then applies `addOptions` (`monitor: none`: every episode
   * unmonitored) and clears them. Episodes followed before that were
   * unfollowed again, so a request for some seasons or episodes was approved
   * but nothing was downloaded. Until `addOptions` is gone the add isn't done.
   */
  async whenAdded(seriesId: number, waitMs: number): Promise<EpisodeRecord[] | undefined> {
    const pollMs = this.options.pollMs ?? 2000;
    const until = Date.now() + waitMs;
    for (;;) {
      const series = await this.call<ArrTitle>('GET', `/series/${seriesId}`);
      if (!series.addOptions) return this.episodes(seriesId);
      if (Date.now() >= until) return undefined;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Follows these episodes, and whole seasons (also their later episodes),
   * and has Sonarr search for the episodes now. The show itself is followed
   * too: Sonarr only downloads episodes of a followed show on its own (RSS).
   */
  async monitorParts(seriesId: number, seasons: number[], episodeIds: number[]): Promise<void> {
    const series = await this.call<ArrTitle & { seasons?: { seasonNumber: number }[] }>(
      'GET',
      `/series/${seriesId}`,
    );
    // A season that turns monitored has Sonarr follow all its episodes.
    await this.call<ArrTitle>('PUT', `/series/${seriesId}`, {
      ...series,
      monitored: true,
      seasons: (series.seasons ?? []).map((season) =>
        seasons.includes(season.seasonNumber) ? { ...season, monitored: true } : season,
      ),
    });
    if (episodeIds.length === 0) return;
    await this.call<void>('PUT', '/episode/monitor', { episodeIds, monitored: true });
    await this.call<unknown>('POST', '/command', { name: 'EpisodeSearch', episodeIds });
  }

  /** Which of these episodes Sonarr follows now. */
  async monitored(seriesId: number, episodeIds: number[]): Promise<Set<number>> {
    const wanted = new Set(episodeIds);
    const episodes = await this.episodes(seriesId);
    return new Set(episodes.filter((e) => wanted.has(e.id) && e.monitored).map((e) => e.id));
  }

  /** Adds the show with all its seasons and has Sonarr search for the episodes. */
  async add(
    show: ArrTitle,
    target: { rootFolderPath: string; qualityProfileId: number },
    anime: boolean,
  ) {
    const languageProfileId = await this.languageProfileId();
    return this.call<ArrTitle>('POST', '/series', {
      ...show,
      rootFolderPath: target.rootFolderPath,
      qualityProfileId: target.qualityProfileId,
      ...(languageProfileId && { languageProfileId }),
      seriesType: anime ? 'anime' : 'standard',
      seasonFolder: true,
      monitored: true,
      addOptions: { monitor: 'all', searchForMissingEpisodes: true },
    });
  }
}
