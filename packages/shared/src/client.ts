// Typed client for the CineVault REST API, used by the web app and (later) Expo.

import type {
  CalendarLink,
  CalendarList,
  CalendarScope,
  DownloadEntry,
  RemovePreview,
  RemoveResult,
  RemoveTarget,
  AuthStatus,
  ContinueEntry,
  DeviceLoginInfo,
  DeviceLoginPoll,
  DeviceLoginStart,
  ProgressDto,
  LoginResponse,
  NewUser,
  UserChanges,
  UserDto,
  CodecStats,
  DiscoverDetails,
  DiscoverFeed,
  DiscoverPage,
  CastLink,
  CastStatus,
  FileContext,
  IntroInfo,
  IntroRange,
  CollectionDetails,
  CollectionSummary,
  HealthReport,
  IntroStatus,
  SeasonMarkers,
  SkipSettings,
  ThemeChoice,
  ThemeInfo,
  ThemeStatus,
  ThumbnailInfo,
  TrackChoiceUpdate,
  PictureInfo,
  HealthResponse,
  HomeDto,
  ItemSort,
  ItemDetails,
  ItemSummary,
  LibrarySummary,
  MatchCandidate,
  MetadataProvider,
  MediaRequestDto,
  DiscoverSeasonDetails,
  RequestParts,
  MetadataStatus,
  NotificationList,
  NotificationSettings,
  Page,
  PlaybackRequest,
  PlaybackSession,
  RequestKind,
  RequestSearchResult,
  RequestsConfig,
  ScanStatus,
  TranscoderStatus,
  WebPushSubscription,
} from './index.js';
import type {
  ExtractedSubtitles,
  SubtitleExtraction,
  SubtitleOption,
  SubtitleSearchResult,
} from './subtitles.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Server origin, e.g. "http://192.168.1.10:8765". Empty for the same origin (web app). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Token for "Authorization: Bearer" (Expo). The web app leaves this out:
   * the browser sends the login cookie by itself.
   */
  token?: () => string | undefined;
  /** Called on 401, e.g. to show the login screen. */
  onUnauthorized?: () => void;
}

export interface ItemsQuery {
  search?: string;
  status?: MetadataStatus;
  sort?: ItemSort;
  genre?: string;
  page?: number;
  pageSize?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function createApiClient(options: ApiClientOptions = {}) {
  const origin = (options.baseUrl ?? '').replace(/\/+$/, '');
  const api = `${origin}/api`;
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = options.token?.();
    const response = await fetchFn(`${api}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (response.status === 401 && !path.startsWith('/auth/')) options.onUnauthorized?.();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const data = (await response.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Not JSON; keep the status text.
      }
      throw new ApiError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function text(url: string): Promise<Response> {
    const token = options.token?.();
    const response = await fetchFn(
      url,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    if (response.status === 401) options.onUnauthorized?.();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const data = (await response.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Not JSON.
      }
      throw new ApiError(response.status, message);
    }
    return response;
  }

  return {
    health: () => request<HealthResponse>('GET', '/health'),
    authStatus: () => request<AuthStatus>('GET', '/auth/status'),
    /** The first account, which becomes the admin. */
    setup: (body: { displayName: string; username: string; password: string }) =>
      request<LoginResponse>('POST', '/auth/setup', body),
    login: (username: string, password: string) =>
      request<LoginResponse>('POST', '/auth/login', { username, password }),
    logout: () => request<void>('POST', '/auth/logout'),
    /** A TV: a code to log in with on a phone. */
    startDeviceLogin: (deviceName: string) =>
      request<DeviceLoginStart>('POST', '/auth/device', { deviceName }),
    /** A TV: asks whether the code was confirmed (then it is logged in). */
    pollDeviceLogin: (secret: string) =>
      request<DeviceLoginPoll>('POST', '/auth/device/poll', { secret }),
    /** The phone: which device asks, before confirming. */
    deviceLogin: (code: string) =>
      request<DeviceLoginInfo>('GET', `/auth/device/${encodeURIComponent(code)}`),
    /** The phone: log the TV in as me. */
    approveDeviceLogin: (code: string) =>
      request<void>('POST', `/auth/device/${encodeURIComponent(code)}/approve`),
    me: () => request<UserDto>('GET', '/auth/me'),
    updateMe: (changes: UserChanges) => request<UserDto>('PATCH', '/auth/me', changes),
    /**
     * Where the profile is in a file. `keepalive` lets the request finish
     * while the page closes (leaving the player).
     */
    reportProgress: async (
      fileId: string,
      positionMs: number,
      durationMs?: number,
      init: { keepalive?: boolean } = {},
    ): Promise<ProgressDto | undefined> => {
      const token = options.token?.();
      const response = await fetchFn(`${api}/progress/${fileId}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          positionMs: Math.max(0, Math.round(positionMs)),
          ...(durationMs && { durationMs: Math.round(durationMs) }),
        }),
        ...(init.keepalive && { keepalive: true }),
      });
      if (response.status === 401) options.onUnauthorized?.();
      return response.ok ? ((await response.json()) as ProgressDto) : undefined;
    },
    continueWatching: () => request<ContinueEntry[]>('GET', '/continue'),
    setWatched: (kind: 'items' | 'seasons' | 'episodes', id: string, watched: boolean) =>
      request<void>('PUT', `/${kind}/${id}/watched`, { watched }),
    users: () => request<UserDto[]>('GET', '/users'),
    createUser: (user: NewUser) => request<UserDto>('POST', '/users', user),
    updateUser: (id: string, changes: UserChanges) =>
      request<UserDto>('PATCH', `/users/${id}`, changes),
    deleteUser: (id: string) => request<void>('DELETE', `/users/${id}`),
    libraries: () => request<LibrarySummary[]>('GET', '/libraries'),
    items: (libraryId: string, q: ItemsQuery = {}) =>
      request<Page<ItemSummary>>('GET', `/libraries/${libraryId}/items${query({ ...q })}`),
    genres: (libraryId: string) => request<string[]>('GET', `/libraries/${libraryId}/genres`),
    home: () => request<HomeDto>('GET', '/home'),
    search: (q: string, limit = 40) =>
      request<ItemSummary[]>('GET', `/search${query({ q, limit })}`),
    item: (id: string) => request<ItemDetails>('GET', `/items/${id}`),
    /** "Meer zoals dit": titles in the library like this one. */
    similar: (id: string) => request<ItemSummary[]>('GET', `/items/${id}/similar`),
    /** "Mijn lijst" of the signed-in profile, the last added first. */
    myList: () => request<ItemSummary[]>('GET', '/my-list'),
    setInMyList: (itemId: string, inList: boolean) =>
      request<void>(inList ? 'PUT' : 'DELETE', `/my-list/${itemId}`),
    /** "Agenda": episodes of the last week and the coming year. */
    calendar: (scope: CalendarScope = 'following') =>
      request<CalendarList>('GET', `/calendar${query({ scope })}`),
    /** The secret link to subscribe to (made on first use). */
    calendarLink: () => request<CalendarLink>('GET', '/calendar/link'),
    /** A new link; the old one stops working. */
    resetCalendarLink: () => request<CalendarLink>('POST', '/calendar/link'),
    /** The inbox, the newest first; `after` gives only newer ones (an app polling). */
    notifications: (q: { after?: number; limit?: number } = {}) =>
      request<NotificationList>('GET', `/notifications${query({ ...q })}`),
    /** Marks these, or all, as read. */
    readNotifications: (ids?: number[]) =>
      request<void>('POST', '/notifications/read', ids ? { ids } : { all: true }),
    notificationSettings: () => request<NotificationSettings>('GET', '/notifications/settings'),
    setNotificationSettings: (settings: Partial<NotificationSettings>) =>
      request<NotificationSettings>('PUT', '/notifications/settings', settings),
    /** The server's web push key (VAPID), to subscribe a browser with. */
    pushKey: () => request<{ publicKey: string }>('GET', '/notifications/push/key'),
    subscribePush: (subscription: WebPushSubscription) =>
      request<void>('POST', '/notifications/push', subscription),
    unsubscribePush: (endpoint: string) =>
      request<void>('POST', '/notifications/push/remove', { endpoint }),
    /** "Ontdekken": rows of new and trending titles on TMDB. */
    discover: () => request<DiscoverFeed>('GET', '/discover'),
    /** One row, page by page. */
    discoverRow: (id: string, page = 1) =>
      request<DiscoverPage>('GET', `/discover/rows/${encodeURIComponent(id)}${query({ page })}`),
    /** Movies and shows on TMDB at once. */
    discoverSearch: (q: string, page = 1) =>
      request<DiscoverPage>('GET', `/discover/search${query({ q, page })}`),
    discoverDetails: (kind: RequestKind, tmdbId: number) =>
      request<DiscoverDetails>('GET', `/discover/${kind}/${tmdbId}`),
    /** A season's episodes, to ask for some of them. */
    discoverSeason: (tmdbId: number, seasonNumber: number) =>
      request<DiscoverSeasonDetails>('GET', `/discover/show/${tmdbId}/season/${seasonNumber}`),
    /** "Verzoeken": titles on TMDB to ask for. */
    searchRequests: (q: string, kind: RequestKind) =>
      request<RequestSearchResult[]>('GET', `/requests/search${query({ q, kind })}`),
    requests: () => request<MediaRequestDto[]>('GET', '/requests'),
    /** "Wordt gedownload": what Radarr and Sonarr are downloading now. */
    downloads: () => request<DownloadEntry[]>('GET', '/downloads'),
    /** Admins: what removing (through Radarr or Sonarr) would do. */
    removePreview: (itemId: string, target: RemoveTarget) =>
      request<RemovePreview>('GET', `/items/${itemId}/remove${query({ ...target })}`),
    /** Admins: has Radarr or Sonarr delete the title, season or episode from the disk. */
    remove: (itemId: string, target: RemoveTarget) =>
      request<RemoveResult>('POST', `/items/${itemId}/remove`, target),
    /** A title; for a show also only some seasons or episodes (`seasons`, `episodes`). */
    createRequest: (body: { kind: RequestKind; tmdbId: number; anime?: boolean } & RequestParts) =>
      request<MediaRequestDto>('POST', '/requests', body),
    /** Admins; `anime` files a show as anime in Sonarr. */
    approveRequest: (id: string, options: { anime?: boolean } = {}) =>
      request<MediaRequestDto>('POST', `/requests/${id}/approve`, options),
    declineRequest: (id: string, reason?: string) =>
      request<MediaRequestDto>('POST', `/requests/${id}/decline`, reason ? { reason } : {}),
    /** Your own request while it waits, or (admins) any. */
    deleteRequest: (id: string) => request<void>('DELETE', `/requests/${id}`),
    requestsConfig: () => request<RequestsConfig>('GET', '/requests/config'),
    setRequestsConfig: (
      config: Partial<Pick<RequestsConfig, 'autoApprove' | 'movies' | 'shows' | 'anime'>>,
    ) => request<RequestsConfig>('PUT', '/requests/config', config),
    /** Sends a test notification to this profile. */
    testNotification: () => request<void>('POST', '/notifications/test'),
    file: (id: string) => request<FileContext>('GET', `/files/${id}`),
    picture: (id: string) => request<PictureInfo>('GET', `/files/${id}/picture`),
    /** A show's theme music (the sound of its intro); `pending` while it is made. */
    /** `ready`: only a theme that is made already (browsing), without making one. */
    theme: (itemId: string, options: { ready?: boolean } = {}) =>
      request<ThemeInfo>('GET', `/items/${itemId}/theme${options.ready ? '?ready=1' : ''}`),
    /** Preview pictures for the timeline, once the server made them. */
    thumbnails: (fileId: string) => request<ThumbnailInfo>('GET', `/files/${fileId}/thumbnails`),
    /** Admins: the intro of another episode as the theme, or no theme for this show. */
    setTheme: (itemId: string, choice: ThemeChoice) =>
      request<ThemeInfo>('PUT', `/items/${itemId}/theme`, choice),
    /** Remembers the audio or subtitles chosen for this show, for its other episodes. */
    setTracks: (itemId: string, choice: TrackChoiceUpdate) =>
      request<{ ok: true }>('PUT', `/items/${itemId}/tracks`, choice),
    /** The parts of an episode; `all` (admins): also those too uncertain for the players. */
    intro: (fileId: string, options: { all?: boolean } = {}) =>
      request<IntroInfo>('GET', `/files/${fileId}/intro${options.all ? '?all=1' : ''}`),
    /** Admins: the intro as set by hand, or `null` for "this episode has none". */
    setIntro: (fileId: string, intro: IntroRange | null) =>
      intro
        ? request<IntroInfo>('PUT', `/files/${fileId}/intro`, intro)
        : request<IntroInfo>('DELETE', `/files/${fileId}/intro`),
    /** Admins: look for the intro again (forgets one set by hand). */
    detectIntro: (fileId: string) => request<IntroInfo>('POST', `/files/${fileId}/intro/detect`),
    /** Admins: the end credits as set by hand, or `null` for "this episode has none". */
    setCredits: (fileId: string, credits: IntroRange | null) =>
      credits
        ? request<IntroInfo>('PUT', `/files/${fileId}/credits`, credits)
        : request<IntroInfo>('DELETE', `/files/${fileId}/credits`),
    /** Admins: look for the end credits again (forgets ones set by hand). */
    detectCredits: (fileId: string) =>
      request<IntroInfo>('POST', `/files/${fileId}/credits/detect`),
    /** Admins: the recap as set by hand, or `null` for "this episode has none". */
    setRecap: (fileId: string, recap: IntroRange | null) =>
      recap
        ? request<IntroInfo>('PUT', `/files/${fileId}/recap`, recap)
        : request<IntroInfo>('DELETE', `/files/${fileId}/recap`),
    /** Admins: look for the recap again (forgets one set by hand). */
    detectRecap: (fileId: string) => request<IntroInfo>('POST', `/files/${fileId}/recap/detect`),
    /** Admins: the preview of the next episode as set by hand, or `null` for "none". */
    setPreview: (fileId: string, preview: IntroRange | null) =>
      preview
        ? request<IntroInfo>('PUT', `/files/${fileId}/preview`, preview)
        : request<IntroInfo>('DELETE', `/files/${fileId}/preview`),
    /** Admins: look for the preview again (forgets one set by hand). */
    detectPreview: (fileId: string) =>
      request<IntroInfo>('POST', `/files/${fileId}/preview/detect`),
    /** What the players skip by themselves for this profile. */
    skipSettings: () => request<SkipSettings>('GET', '/skip-settings'),
    setSkipSettings: (settings: Partial<SkipSettings>) =>
      request<SkipSettings>('PUT', '/skip-settings', settings),
    /** Admins: every episode of a season with its intro, recap, credits and preview. */
    seasonMarkers: (seasonId: string) =>
      request<SeasonMarkers>('GET', `/admin/seasons/${seasonId}/markers`),
    /** Admins: one episode's intro (or credits) by hand on all episodes of its season. */
    copyMarker: (seasonId: string, body: { fileId: string; kind: 'intro' | 'credits' }) =>
      request<SeasonMarkers>('POST', `/admin/seasons/${seasonId}/markers/copy`, body),
    /** Admins: look at the whole season again (not what was set by hand). */
    detectSeasonMarkers: (seasonId: string) =>
      request<SeasonMarkers>('POST', `/admin/seasons/${seasonId}/markers/detect`, {}),
    introStatus: () => request<IntroStatus>('GET', '/intro/status'),
    /** Looks at every episode still to do now (`all`: every episode again). */
    searchAllIntros: (body: { all?: boolean } = {}) =>
      request<IntroStatus>('POST', '/intro/run', body),
    stopSearchAllIntros: () => request<IntroStatus>('DELETE', '/intro/run'),
    themeStatus: () => request<ThemeStatus>('GET', '/themes/status'),
    /** Admins: ask Plex again now for the shows without theme music. */
    retryThemes: () => request<ThemeStatus>('POST', '/themes/retry', {}),
    /** Collections with at least two films in the library. */
    collections: () => request<CollectionSummary[]>('GET', '/collections'),
    collection: (id: number) => request<CollectionDetails>('GET', `/collections/${id}`),
    /** Admins: Beheer → Gezondheid (`fresh`: look again now). */
    serverHealth: (fresh = false) =>
      request<HealthReport>('GET', `/admin/health${fresh ? '?fresh=1' : ''}`),
    castLink: (fileId: string, sessionId: string) =>
      request<CastLink>('POST', '/cast/token', { fileId, sessionId }),
    /** What the TV fetched of a cast session (to say why nothing plays). */
    castStatus: (sessionId: string) => request<CastStatus>('GET', `/cast/status/${sessionId}`),
    candidates: (id: string, q: { title?: string; year?: number } = {}) =>
      request<MatchCandidate[]>('GET', `/items/${id}/candidates${query(q)}`),
    setMatch: (id: string, match: { provider: MetadataProvider; id: number }) =>
      request<ItemDetails>('PUT', `/items/${id}/match`, match),
    clearMatch: (id: string) => request<ItemDetails>('DELETE', `/items/${id}/match`),
    scanStatus: () => request<ScanStatus>('GET', '/scan'),
    startScan: (body: { libraryId?: string; refreshMetadata?: boolean } = {}) =>
      request<ScanStatus>('POST', '/scan', body),
    codecStats: () => request<CodecStats>('GET', '/stats/codecs'),
    /** Starts an HLS session (remux or transcode) on the transcoder. */
    startPlayback: (body: PlaybackRequest) => request<PlaybackSession>('POST', '/playback', body),
    /** Session status; also keeps an idle session alive. */
    playbackSession: (id: string) => request<PlaybackSession>('GET', `/playback/${id}`),
    stopPlayback: (id: string) => request<void>('DELETE', `/playback/${id}`),
    transcoderStatus: () => request<TranscoderStatus>('GET', '/transcoder'),
    subtitles: (fileId: string) => request<SubtitleOption[]>('GET', `/files/${fileId}/subtitles`),
    /** A picture subtitle (PGS) read as text by the server; it takes a few minutes. */
    readSubtitle: (fileId: string, streamIndex: number) =>
      request<SubtitleOption>('POST', `/files/${fileId}/subtitles/ocr`, { streamIndex }),
    /**
     * A subtitle for a Chromecast, as one whole WebVTT file: ask again until
     * the answer has a `url` (an embedded track is read whole, a picture track as text).
     */
    prepareSubtitle: (fileId: string, subtitleId: string) =>
      request<SubtitleOption>(
        'POST',
        `/files/${fileId}/subtitles/${encodeURIComponent(subtitleId)}/prepare`,
      ),
    /** A whole subtitle as WebVTT (SubtitleOption.url, relative to the server). */
    subtitleText: async (url: string) => (await text(`${origin}${url}`)).text(),
    setSubtitleOffset: (fileId: string, subtitleId: string, offsetMs: number) =>
      request<SubtitleOption>(
        'PUT',
        `/files/${fileId}/subtitles/${encodeURIComponent(subtitleId)}/offset`,
        { offsetMs },
      ),
    /** Starts reading an embedded track from `start` seconds. */
    extractSubtitles: (fileId: string, streamIndex: number, start: number) =>
      request<SubtitleExtraction>('POST', `/files/${fileId}/subtitles/extract`, {
        streamIndex,
        start,
      }),
    extracted: async (id: string): Promise<ExtractedSubtitles> => {
      const response = await text(`${api}/subtitle-extractions/${id}`);
      return {
        vtt: await response.text(),
        covered: Number(response.headers.get('x-covered') ?? 0),
        complete: response.headers.get('x-complete') === '1',
      };
    },
    stopExtraction: (id: string) => request<void>('DELETE', `/subtitle-extractions/${id}`),
    searchSubtitles: (fileId: string, languages: string[]) =>
      request<SubtitleSearchResult[]>(
        'GET',
        `/files/${fileId}/subtitles/search${query({ languages: languages.join(',') })}`,
      ),
    downloadSubtitle: (fileId: string, resultId: string) =>
      request<SubtitleOption>('POST', `/files/${fileId}/subtitles/download`, { id: resultId }),
    deleteSubtitle: (id: string) => request<void>('DELETE', `/subtitles/${id}`),
    /** For <video src>; the server supports range requests. */
    streamUrl: (fileId: string) => `${api}/files/${fileId}/stream`,
    /** The API returns image URLs relative to the server ("/api/images/…"). */
    resolveUrl: (path: string | undefined) => (path ? `${origin}${path}` : undefined),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
