// Types shared between the API, the web app and (later) the Expo app.

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  /** Git commit the API image was built from (scripts/up.sh), to see which code runs. */
  commit?: string;
  database: 'up' | 'down';
}

export type UserRole = 'ADMIN' | 'USER';

/** A member of the household (one account, one profile). */
export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  /** Profile colour, "#RRGGBB". */
  avatarColor?: string;
  role: UserRole;
  /** A kids profile: only titles rated up to this age (0 is "AL"). */
  maxAge?: number;
  lastLoginAt?: string;
  createdAt: string;
}

export interface AuthStatus {
  /** No accounts yet: the first one becomes the admin (POST /api/auth/setup). */
  setupRequired: boolean;
  user?: UserDto;
}

export interface LoginResponse {
  user: UserDto;
  /** The same token as the cookie, for clients that send "Authorization: Bearer" (Expo). */
  token: string;
}

/** POST /auth/device: a code for logging in on a TV with a phone. */
export interface DeviceLoginStart {
  /** "BCDF2345": shown as BCDF-2345, and in the QR code (/link?code=…). */
  code: string;
  /** Only the TV knows it: POST /auth/device/poll with it. */
  secret: string;
  /** ISO 8601. */
  expiresAt: string;
  /** Ask this often (seconds). */
  interval: number;
}

/** GET /auth/device/:code: what the phone shows before confirming. */
export interface DeviceLoginInfo {
  code: string;
  deviceName: string;
  expiresAt: string;
  approved: boolean;
}

/** POST /auth/device/poll: still waiting, logged in (once), or the code is gone. */
export type DeviceLoginPoll =
  { status: 'pending' } | ({ status: 'approved' } & LoginResponse) | { status: 'expired' };

export interface NewUser {
  displayName: string;
  username: string;
  password: string;
  role?: UserRole;
  /** A kids profile: only titles rated up to this age (0 is "AL"). */
  maxAge?: number | null;
}

export interface UserChanges {
  displayName?: string;
  avatarColor?: string;
  role?: UserRole;
  /** null lifts the limit. */
  maxAge?: number | null;
  /** Admins set a new password for others; for yourself, give `currentPassword` too. */
  password?: string;
  currentPassword?: string;
}

export interface AudioTrack {
  /** Stream index in the file, as FFmpeg numbers it. */
  index: number;
  codec: string;
  language?: string;
  channels?: number;
  layout?: string;
  title?: string;
  default: boolean;
}

export interface SubtitleTrack {
  index: number;
  codec: string;
  language?: string;
  title?: string;
  forced: boolean;
  default: boolean;
  /** Text formats (SRT, ASS, WebVTT) convert to WebVTT; image formats (PGS, VobSub) don't. */
  textBased: boolean;
}

export type HdrFormat = 'HDR10' | 'HLG' | 'DV';

// --- Libraries and scanning -------------------------------------------------

export type LibraryType = 'MOVIES' | 'SHOWS' | 'ANIME';

export interface LibrarySummary {
  id: string;
  name: string;
  type: LibraryType;
  /** Relative to MEDIA_ROOT. */
  path: string;
  lastScannedAt?: string;
  itemCount: number;
}

export interface ScanStatus {
  running: boolean;
  phase: 'idle' | 'files' | 'probe' | 'metadata' | 'done';
  libraryName?: string;
  startedAt?: string;
  finishedAt?: string;
  filesFound: number;
  filesProbed: number;
  probeErrors: number;
  filesRemoved: number;
  itemsTotal: number;
  itemsMatched: number;
  itemsUnmatched: number;
  itemsFailed: number;
  /** Most recent problems, for display. */
  errors: string[];
}

// --- Items ------------------------------------------------------------------

export type MediaType = 'MOVIE' | 'SHOW';
export type MetadataStatus = 'PENDING' | 'MATCHED' | 'UNMATCHED' | 'FAILED';
export type MetadataProvider = 'tmdb' | 'tvmaze';

export interface ItemSummary {
  id: string;
  libraryId: string;
  type: MediaType;
  title: string;
  year?: number;
  posterUrl?: string;
  /** Wide image, for landscape cards and the start page. */
  backdropUrl?: string;
  /** For the TV's header, which shows the focused title. */
  overview?: string;
  rating?: number;
  genres?: string[];
  /** The title as a picture (transparent PNG), for the TV's header. */
  logoUrl?: string;
  runtimeMinutes?: number;
  /** From which age (Kijkwijzer; 0 is "AL"), when known. */
  ageRating?: number;
  metadataStatus: MetadataStatus;
  /** Why the last lookup didn't match or failed. */
  metadataError?: string;
  /** For the signed-in profile. */
  progress?: ItemProgress;
  /** In the signed-in profile's "Mijn lijst". */
  inMyList?: boolean;
}

/** How a list of titles is ordered (GET /libraries/:id/items?sort=). */
export type ItemSort = 'title' | 'added' | 'year' | 'rating';

/** A title in the start page's billboard, with what "Afspelen" plays. */
export interface FeaturedItem extends ItemSummary {
  /** The title as a picture (transparent PNG); the name is shown without it. */
  logoUrl?: string;
  backdropUrl: string;
  overview?: string;
  tagline?: string;
  genres: string[];
  rating?: number;
  runtimeMinutes?: number;
  /** Of the file that plays: for "4K" and "HDR" labels. */
  height?: number;
  hdrFormat?: string;
  play?: {
    fileId: string;
    /** Where the profile stopped, when it did. */
    positionMs?: number;
    durationMs?: number;
    /** Shows: the episode that plays. */
    seasonNumber?: number;
    episodeNumber?: number;
  };
}

/** A show's new episodes on the start page ("Nieuwe afleveringen"). */
export interface NewEpisodes {
  /** The show. */
  item: ItemSummary;
  /** The first of the new episodes, the one to start with. */
  fileId: string;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  stillUrl?: string;
  /** When the newest of them arrived, ISO 8601. */
  addedAt: string;
  /** How many came in together (within a week of the newest), this one included. */
  count: number;
  /** How far this profile got in the first of them (0-1), when it started it. */
  fraction?: number;
}

/** A show's next episode that has not aired yet ("Binnenkort"). */
export interface UpcomingEpisode {
  item: ItemSummary;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  /** YYYY-MM-DD. */
  airDate: string;
}

/** An episode in the calendar ("Agenda"): aired lately or coming up. */
export interface CalendarEpisode {
  item: ItemSummary;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  /** YYYY-MM-DD. */
  airDate: string;
  /** The episode is in the library already. */
  available: boolean;
}

/** Which shows the calendar shows: the ones followed, or all in the library. */
export type CalendarScope = 'following' | 'all';

export interface CalendarList {
  scope: CalendarScope;
  /** Today where the server is, YYYY-MM-DD. */
  today: string;
  episodes: CalendarEpisode[];
}

/** The profile's secret calendar link, to add in Google Calendar, Apple or ICSx⁵. */
export interface CalendarLink {
  /** https://…/api/calendar/ics/<token>.ics */
  url: string;
  /** The same as webcal://, which calendar apps open as a subscription. */
  webcalUrl: string;
  /** Opens Google Calendar's "add by URL" with the link. */
  googleUrl: string;
  /** False when the link is plain HTTP: Google can't reach it then. */
  secure: boolean;
}

/** A row of posters on the start page. */
export interface HomeRow {
  id: string;
  title: string;
  /** Where "Alles bekijken" goes. */
  libraryId?: string;
  sort?: ItemSort;
  genre?: string;
  /** The titles of the row; for an episodes row, the shows (for older apps). */
  items: ItemSummary[];
  /** Set for "Nieuwe afleveringen": landscape cards with the episode. */
  episodes?: NewEpisodes[];
  /** Set for "Binnenkort": landscape cards with the air date. */
  upcoming?: UpcomingEpisode[];
  /** Set for "Omdat je … keek": the title the row is like. */
  because?: { itemId: string; title: string };
  /** Set for "Collecties": collection cards (`items` has a film of each, for older apps). */
  collections?: CollectionSummary[];
}

/** A collection of films ("Harry Potter Collection"), at TMDB. */
export interface CollectionSummary {
  /** TMDB's id of the collection. */
  id: number;
  name: string;
  posterUrl?: string;
  backdropUrl?: string;
  /** Films of it in the library (that this profile may see), of all of them. */
  owned: number;
  total: number;
  /** Of those in the library, watched by this profile. */
  watched: number;
}

/** One film of a collection, in the library or not. */
export interface CollectionPart {
  tmdbId: number;
  title: string;
  year?: number;
  releaseDate?: string;
  posterUrl?: string;
  /** Out already (else announced: no date yet, or one in the future). */
  released: boolean;
  /** In the library: the title, with the profile's progress. */
  item?: ItemSummary;
  /** Not in the library, but asked for (Verzoeken). */
  requested?: boolean;
}

/** GET /api/collections/:id. */
export interface CollectionDetails extends CollectionSummary {
  overview?: string;
  /** In the order they came out. */
  parts: CollectionPart[];
  /** The film to watch next: after the last one watched, else the first. */
  next?: ItemSummary;
}

/** GET /home: the billboard and the rows below it ("Verder kijken" is /continue). */
export interface HomeDto {
  featured: FeaturedItem[];
  rows: HomeRow[];
}

/** How far the signed-in profile got with a movie or show. */
export interface ItemProgress {
  watched: boolean;
  /** 0-1, for a movie that was stopped halfway. */
  fraction?: number;
  /** Shows: episodes watched of all regular episodes (no specials). */
  watchedEpisodes?: number;
  totalEpisodes?: number;
}

/** Where the signed-in profile is in one file. */
export interface ProgressDto {
  fileId: string;
  positionMs: number;
  durationMs?: number;
  watched: boolean;
  updatedAt: string;
}

/** A row of "Verder kijken" (GET /api/continue). */
export interface ContinueEntry {
  /** "resume": stopped halfway; "next": the episode after the last one watched. */
  kind: 'resume' | 'next';
  item: ItemSummary;
  fileId: string;
  episode?: {
    id: string;
    seasonNumber: number;
    episodeNumber: number;
    title?: string;
    stillUrl?: string;
  };
  backdropUrl?: string;
  positionMs: number;
  durationMs?: number;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CastMemberDto {
  name: string;
  character?: string;
  profileUrl?: string;
}

export interface MediaFileDto {
  id: string;
  /** Relative to MEDIA_ROOT. */
  path: string;
  size: number;
  container?: string;
  videoCodec?: string;
  width?: number;
  height?: number;
  bitDepth?: number;
  hdrFormat?: HdrFormat;
  /** Dolby Vision profile (5: DV only; 8: with an HDR10 or HLG base) and that compatibility id. */
  dvProfile?: number;
  dvCompatibility?: number;
  durationMs?: number;
  bitrate?: number;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  probeError?: string;
}

export interface EpisodeDto {
  id: string;
  episodeNumber: number;
  absoluteNumber?: number;
  title?: string;
  overview?: string;
  airDate?: string;
  runtimeMinutes?: number;
  stillUrl?: string;
  files: MediaFileDto[];
  /** For the signed-in profile. */
  progress?: ProgressDto;
}

export interface SeasonDto {
  id: string;
  seasonNumber: number;
  title?: string;
  overview?: string;
  posterUrl?: string;
  episodes: EpisodeDto[];
}

export interface ItemDetails extends ItemSummary {
  /** Episodes (or the film) in the queue of Radarr or Sonarr now. */
  download?: DownloadProgress;
  originalTitle?: string;
  overview?: string;
  tagline?: string;
  genres: string[];
  rating?: number;
  runtimeMinutes?: number;
  status?: string;
  backdropUrl?: string;
  cast: CastMemberDto[];
  ids: { tmdb?: number; tvmaze?: number; tvdb?: number; imdb?: string };
  /** e.g. "tmdb" or "tmdb+tvmaze"; the UI shows the matching attribution. */
  metadataProvider?: string;
  /** The title as a picture (transparent PNG). */
  logoUrl?: string;
  /** YouTube video id of the trailer (trailerUrl, trailerEmbedUrl). */
  trailerKey?: string;
  /** Shows: the next episode that has not aired yet. */
  nextEpisode?: Omit<UpcomingEpisode, 'item'>;
  /** Films: the collection it is part of, with how many of its films are here. */
  collection?: { id: number; name: string; owned: number; total: number };
  matchLocked: boolean;
  /** Movies: the file(s). Shows: empty, files hang off episodes. */
  files: MediaFileDto[];
  seasons: SeasonDto[];
  /** Movies: where the signed-in profile stopped. */
  resume?: ProgressDto;
}

/** A search result for a manual match. */
export interface MatchCandidate {
  provider: MetadataProvider;
  id: number;
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
}

/** GET /api/stats/codecs: counts per value, over all files. */
export interface CodecStats {
  files: number;
  containers: Record<string, number>;
  videoCodecs: Record<string, number>;
  resolutions: Record<string, number>;
  hdr: Record<string, number>;
  /** Codec of the default (or first) audio track: the one a browser plays. */
  defaultAudioCodecs: Record<string, number>;
}

export * from './client.js';
export * from './directPlay.js';
export * from './cast.js';
export * from './format.js';
export * from './intro.js';
export * from './playback.js';
export * from './script.js';
export * from './subtitles.js';
export * from './viewing.js';
export * from './thumbnails.js';

/** POST /api/cast/token: where a Chromecast fetches one playback session. */
export interface CastLink {
  /** The HLS playlist of the session. */
  playlistUrl: string;
  posterUrl: string;
  /** With "{id}" for the subtitle id; add `?shiftMs=` to move its times. */
  subtitleUrl: string;
  expiresAt: string;
}

/**
 * GET /api/cast/status/:sessionId: what the TV fetched of a cast session, so
 * the phone or browser can say why nothing plays (the TV doesn't reach the
 * address, or it got the stream and can't play it).
 */
export interface CastStatus {
  /** Where the TV was sent: CAST_BASE_URL, else the address the phone used. */
  base: string;
  /** Whether that is set on the server (CAST_BASE_URL). */
  configured: boolean;
  playlist: number;
  init: number;
  segments: number;
  /** The last request of the TV (ISO), and its browser ("CrKey/…" on a Chromecast). */
  lastAt?: string;
  userAgent?: string;
  /** Requests the server answered with an error, the last few. */
  errors: { file: string; status: number; at: string }[];
}

/** Where the picture is in the frame, in pixels of the video. */
export interface PictureArea {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * GET /api/files/:id/picture: black bars baked into the frame (a 2.39:1 film
 * in a 16:9 frame). `area` is left out when the picture fills the frame, or
 * when it is not known (no transcoder).
 */
export interface PictureInfo {
  area?: PictureArea;
}

/** Where an episode's intro is (Skip Intro), in milliseconds of the file. */
export interface IntroRange {
  startMs: number;
  endMs: number;
}

/** GET /api/files/:id/intro: the intro and the end credits of an episode. */
export interface IntroInfo {
  intro?: IntroRange;
  /** "chapter", "aniskip" (anime), "audio" (found in the season's audio) or "manual". */
  source?: 'chapter' | 'aniskip' | 'audio' | 'manual';
  /** The end credits: from where the next episode can start (a film: counts as watched). */
  credits?: IntroRange;
  /** "picture": a film's credits, seen in the picture. */
  creditsSource?: 'chapter' | 'aniskip' | 'audio' | 'picture' | 'manual';
  /** A film: more parts of the credits, each after a scene (mid-credits); skipped one by one. */
  moreCredits?: IntroRange[];
  /** The recap ("Previously on…"), when the episode has one. */
  recap?: IntroRange;
  recapSource?: 'chapter' | 'aniskip' | 'audio' | 'manual';
  /** The "next time on…" preview of the next episode, near the end (the credits end there). */
  preview?: IntroRange;
  previewSource?: 'chapter' | 'audio' | 'manual';
  /**
   * How sure the search is of each part (0-1); missing: set by hand, or found
   * before it was measured. Parts under MIN_MARKER_CONFIDENCE are left out
   * for the players; an admin sees them with `?all=1`.
   */
  confidence?: Partial<Record<MarkerKind, number>>;
  /** The parts left out for being uncertain (only for the players' answer). */
  hidden?: MarkerKind[];
  /** The intro or the credits are not looked for yet; ask again later. */
  pending: boolean;
  /** Each on its own (older servers send only `pending`, for the intro). */
  introPending?: boolean;
  creditsPending?: boolean;
  recapPending?: boolean;
  previewPending?: boolean;
}

/** The parts of an episode the players can skip. */
export type MarkerKind = 'intro' | 'recap' | 'credits' | 'preview';
export const MARKER_KINDS: MarkerKind[] = ['intro', 'recap', 'credits', 'preview'];
/** Under this the search isn't sure enough for the players (an admin still sees it). */
export const MIN_MARKER_CONFIDENCE = 0.5;

/**
 * What the players skip by themselves for a profile (GET/PUT /api/skip-settings).
 * `credits`: with a next episode, that one starts at once; else past the credits.
 */
export interface SkipSettings {
  intro: boolean;
  recap: boolean;
  credits: boolean;
  preview: boolean;
}

/** One part of an episode in Beheer's marker overview. */
export interface MarkerDto extends IntroRange {
  source: string;
  confidence?: number;
}

/** GET /api/admin/seasons/:id/markers: every episode of a season with its parts. */
export interface SeasonMarkers {
  seasonId: string;
  seasonNumber: number;
  itemId: string;
  title: string;
  episodes: {
    episodeId: string;
    episodeNumber: number;
    title?: string;
    fileId: string;
    durationMs?: number;
    markers: Partial<Record<MarkerKind, MarkerDto>>;
    /** Parts still to look for. */
    pending: MarkerKind[];
  }[];
  /** The other seasons of the show (regular ones), to switch to. */
  seasons: { id: string; seasonNumber: number }[];
}

/**
 * Preview pictures for the timeline ("trickplay"): picture n shows about
 * n × interval seconds. They are tiled in sheets of columns × rows pictures.
 */
export interface Thumbnails {
  /** Seconds between two pictures. */
  interval: number;
  /** Size of one picture in a sheet, in pixels. */
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** Pictures in all. */
  count: number;
  /** The sheets, in order (relative URLs). */
  sheets: string[];
}

/** GET /api/files/:id/thumbnails. */
export interface ThumbnailInfo {
  thumbnails?: Thumbnails;
  /** Not made yet; the server makes them when nobody watches. */
  pending: boolean;
}

/** GET /api/items/:id/theme: a title's theme music, from its intro or its end credits. */
export interface ThemeInfo {
  /** The MP3 (with a version in the query), or null: there is none (yet). */
  url: string | null;
  /** It is being fetched: ask again in a few seconds. */
  pending: boolean;
  /** An admin turned it off for this title. */
  off: boolean;
  /** Where it comes from. */
  from?: { source: ThemeSourceName };
}

/**
 * Where theme music comes from: Plex's theme service (shows), else the
 * openings of AnimeThemes (anime), else ThemerrDB's YouTube links (shows).
 */
export type ThemeSourceName = 'plex' | 'animethemes' | 'themerrdb';

/** GET /api/themes/status (admin): how far fetching the theme music from Plex is. */
export interface ThemeStatus {
  /** A source is on (PLEX_THEMES, ANIME_THEMES, THEMERRDB). */
  enabled: boolean;
  /** The sources that are on, in the order they are asked. */
  sources?: ThemeSourceName[];
  /** Shows (and anime) with theme music on. */
  shows: number;
  /** Shows whose theme is in the cache. */
  ready: number;
  /** Shows no source has a theme for (asked again after a week). */
  none: number;
  /** Shows for which fetching went wrong otherwise (asked again later). */
  failed: number;
  /** A source could not be reached: no requests to it until then. */
  pausedUntil?: string;
  pausedSource?: ThemeSourceName;
  lastError?: { message: string; at: string };
  /** The shows without theme music, and why (Beheer), by title. */
  missing?: ThemeMissing[];
}

/** A show without theme music: no source has one for it, or fetching failed. */
export interface ThemeMissing {
  itemId: string;
  title: string;
  year?: number;
  tvdbId?: number;
  /** No source has one (404/403, no MP3, no opening); false: fetching went wrong otherwise. */
  none: boolean;
  /** What each source answered: "Plex: 404 https, 404 http · AnimeThemes: geen opening". */
  reason: string;
}

/** PUT /api/items/:id/theme (admin): theme music off or on for a title. */
export interface ThemeChoice {
  off: boolean;
}

/** GET /api/intro/status (admin): how far the intro search is. */
export interface IntroStatus {
  /** Episode files the search covers (regular seasons). */
  episodes: number;
  checked: number;
  found: number;
  /** The same for the end credits. */
  creditsChecked?: number;
  creditsFound?: number;
  /** The same for the recap ("Previously on…"). */
  recapChecked?: number;
  recapFound?: number;
  /** The same for the preview of the next episode. */
  previewChecked?: number;
  previewFound?: number;
  /** Parts found but too uncertain for the players. */
  uncertain?: number;
  /** Films whose end credits the search looks for (from the picture), looked at, found. */
  films?: number;
  filmsChecked?: number;
  filmsFound?: number;
  /** The file being looked at now. */
  current?: string;
  /** Since when (ISO). */
  currentSince?: string;
  /** What the transcoder reads for it now: this file or one it is compared with. */
  reading?: {
    path: string;
    part: 'start' | 'middle' | 'end';
    since: string;
    /** Of `seconds` of audio, read so far (a transcoder that reports it). */
    read?: number;
    seconds?: number;
  };
  /** Waiting for nobody to watch, or for the transcoder. */
  waiting?: 'playback' | 'transcoder';
  /** "Alles nu zoeken": one episode after the other, also while people watch. */
  rush?: boolean;
  /** Why the last "Alles nu zoeken" stopped before everything was done. */
  rushStopped?: 'transcoder' | 'stuck';
}

/** GET /api/files/:id: a file with the title (and episode) it belongs to, for the player. */
export interface FileContext {
  /** The intro, when one is known (episodes). */
  intro?: IntroRange;
  /** The intro has not been looked for yet: GET /files/:id/intro again later. */
  introPending?: boolean;
  /** The end credits, when known (episodes). */
  credits?: IntroRange;
  /** The credits have not been looked for yet. */
  creditsPending?: boolean;
  /** Where they came from ("picture": a film's credits, with a scene after them kept). */
  creditsSource?: IntroInfo['creditsSource'];
  /** A film: more parts of the credits, each after a scene. */
  moreCredits?: IntroRange[];
  /** The recap ("Previously on…"), when known (episodes). */
  recap?: IntroRange;
  /** The preview of the next episode, when known (episodes). */
  preview?: IntroRange;
  /** What this profile's players skip by themselves. */
  skip?: SkipSettings;
  file: MediaFileDto;
  item: ItemSummary;
  episode?: { id: string; seasonNumber: number; episodeNumber: number; title?: string };
  /** Where the signed-in profile stopped in this file. */
  progress?: ProgressDto;
  /** For episodes: the one after it (no specials), to play next. */
  next?: { fileId: string; seasonNumber: number; episodeNumber: number; title?: string };
  /** The audio and subtitles this profile starts this show with. */
  tracks?: TrackChoice;
}

/**
 * The audio and subtitles to start a file with: what the profile chose before
 * for this show (or movie), on any device; for anime, Japanese audio until
 * something else is chosen.
 */
export interface TrackChoice {
  /** ISO 639-2 language of the audio ("jpn"); absent: the file's default track. */
  audioLanguage?: string;
  /** "off" or an ISO 639-2 language ("nld"); absent: the automatic choice. */
  subtitle?: string;
  /** "saved": chosen before; "anime": the default for anime. */
  source: 'saved' | 'anime';
}

/** PUT /items/:id/tracks: what was chosen. null forgets it, absent keeps it. */
export interface TrackChoiceUpdate {
  audioLanguage?: string | null;
  subtitle?: string | null;
}

/**
 * Why a notification was sent:
 * - "new-episodes": a followed show has new episodes to watch;
 * - "airing": a followed show's next episode comes out today;
 * - "recommended": a new title, recommended because of something the profile watched;
 * - "new-login": someone logged in on this account;
 * - "admin-unmatched", "admin-transcoder", "admin-health": for admins, something needs a look;
 * - "request-new": for admins, someone asked for a title;
 * - "request-update": your request was approved, declined, or is here;
 * - "test": sent from the settings, to see that it arrives.
 */
export type NotificationType =
  | 'new-episodes'
  | 'airing'
  | 'recommended'
  | 'new-login'
  | 'admin-unmatched'
  | 'admin-transcoder'
  | 'admin-health'
  | 'request-new'
  | 'request-update'
  | 'test';

export interface NotificationDto {
  id: number;
  type: NotificationType;
  title: string;
  body: string;
  /** What a tap opens: the title's page (or the file to play, with fileId). */
  itemId?: string;
  fileId?: string;
  /** A web path otherwise, e.g. "/admin". */
  path?: string;
  /** The title's wide image, for the inbox. */
  imageUrl?: string;
  /** The title's poster (the phone's notification shows it small). */
  posterUrl?: string;
  /** The episode's own picture, when it is about one (fileId). */
  stillUrl?: string;
  createdAt: string;
  read: boolean;
}

/** GET /api/notifications: the newest first. */
export interface NotificationList {
  items: NotificationDto[];
  unread: number;
}

/** Per profile: which notifications to get. */
export interface NotificationSettings {
  newEpisodes: boolean;
  airing: boolean;
  recommended: boolean;
  newLogin: boolean;
  /** Your requests: approved, declined, ready to watch. */
  requests: boolean;
  /** Admins only (also new requests). */
  admin: boolean;
  /** No push messages between 23:00 and 08:00; they come at 08:00. */
  quietHours: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  newEpisodes: true,
  airing: true,
  recommended: true,
  newLogin: true,
  requests: true,
  admin: true,
  quietHours: true,
};

/** A browser's push subscription (PushSubscription.toJSON()). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** "Verzoeken": a movie or show someone asked for, added to Radarr or Sonarr. */
export type RequestKind = 'movie' | 'show';

/**
 * PENDING: waits for an admin; APPROVED: in Radarr/Sonarr, which looks for it;
 * AVAILABLE: in the library; DECLINED; FAILED: Radarr/Sonarr refused it.
 */
export type RequestStatus = 'PENDING' | 'APPROVED' | 'AVAILABLE' | 'DECLINED' | 'FAILED';

/** GET /api/requests/search: a title on TMDB, and whether it is here or asked for. */
export interface RequestSearchResult {
  kind: RequestKind;
  tmdbId: number;
  title: string;
  year?: number;
  /** YYYY-MM-DD: the release, or a show's first episode. */
  releaseDate?: string;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  /** TMDB's average, 0-10. */
  rating?: number;
  /** Japanese animation: Sonarr files it as anime. */
  anime: boolean;
  /** Already in the library: the title's page. */
  itemId?: string;
  /** Already asked for. */
  request?: { id: string; status: RequestStatus };
  /** In the queue of Radarr or Sonarr now. */
  download?: DownloadProgress;
}

/** What Radarr or Sonarr is doing with a download. */
export type DownloadState =
  'queued' | 'downloading' | 'paused' | 'importing' | 'warning' | 'failed';

/** "Wordt gedownload": a title in the queue of Radarr or Sonarr. */
export interface DownloadProgress {
  state: DownloadState;
  /** 0-1, over all its files in the queue. */
  progress: number;
  sizeBytes?: number;
  leftBytes?: number;
  /** As Radarr/Sonarr estimate it. */
  timeLeftMs?: number;
  /** Why it waits or failed, as Radarr/Sonarr say it. */
  message?: string;
  /** Shows: the episodes in the queue. */
  episodes?: { seasonNumber: number; episodeNumber: number; title?: string }[];
}

/** What an admin removes through Radarr or Sonarr: the whole title, a season or an episode. */
export type RemoveScope = 'title' | 'season' | 'episode';

export interface RemoveTarget {
  scope: RemoveScope;
  /** With scope "season". */
  seasonId?: string;
  /** With scope "episode". */
  episodeId?: string;
}

/** GET /items/:id/remove: what removing would do, for the confirmation. */
export interface RemovePreview extends RemoveTarget {
  service: 'radarr' | 'sonarr';
  /** "Dune (2021)", "Seizoen 2 van The Office", "S2 · A5 · Titel". */
  label: string;
  files: number;
  sizeBytes: number;
  /** Files in CineVault that Sonarr doesn't know; those stay. */
  unknownFiles: number;
}

/** POST /items/:id/remove. */
export interface RemoveResult {
  removedFiles: number;
  /** CineVault scans the library again shortly, and the title (or part) is gone. */
  scanning: boolean;
}

/** One title in the queue (GET /downloads). */
export interface DownloadEntry extends DownloadProgress {
  kind: RequestKind;
  tmdbId?: number;
  title: string;
  posterUrl?: string;
  /** In the library already (e.g. new episodes of a show): its page. */
  itemId?: string;
  /** Asked for in CineVault. */
  requestId?: string;
}

/** A title in "Ontdekken" (TMDB), with whether it is here or asked for. */
export type DiscoverItem = RequestSearchResult;

/** A row in "Ontdekken": the newest releases, trending, anime… */
export interface DiscoverRow {
  id: string;
  title: string;
  kind: RequestKind;
  items: DiscoverItem[];
}

/** GET /api/discover: the rows, the first page of each. */
export interface DiscoverFeed {
  rows: DiscoverRow[];
}

/** A page of one row or of a search, to browse further. */
export interface DiscoverPage {
  id: string;
  title: string;
  items: DiscoverItem[];
  page: number;
  totalPages: number;
}

/** A title's details in "Ontdekken". */
export interface DiscoverDetails extends DiscoverItem {
  genres: string[];
  tagline?: string;
  runtimeMinutes?: number;
  /** Shows: how many seasons there are. */
  seasons?: number;
  status?: string;
  /** YouTube video id (trailerUrl, trailerEmbedUrl). */
  trailerKey?: string;
  /** The actors, the leading ones first. */
  cast: CastMemberDto[];
  /** Shows: the seasons (no specials), to ask for one or a few episodes. */
  seasonList?: DiscoverSeason[];
  /** Films: the collection it is part of, with all its films. */
  collection?: DiscoverCollection;
  /** "Meer zoals dit": TMDB's recommendations for this title. */
  similar?: DiscoverItem[];
}

/** A film's collection in "Ontdekken" ("Harry Potter Collection"). */
export interface DiscoverCollection {
  /** TMDB's id: the collection's page in the library is /collections/:id. */
  id: number;
  name: string;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  /** All its films, in the order they came out (no date yet last), this one too. */
  parts: DiscoverItem[];
  /** How many of them are in the library. */
  owned: number;
}

/** A season of a show in "Ontdekken", as TMDB numbers it. */
export interface DiscoverSeason {
  seasonNumber: number;
  name?: string;
  episodeCount: number;
  /** YYYY-MM-DD of its first episode. */
  airDate?: string;
  posterUrl?: string;
  /** Episodes of it in the library already. */
  inLibrary: number;
  /** Asked for already (as a whole, or the whole show). */
  requested: boolean;
}

/** GET /discover/show/:tmdbId/season/:n: its episodes, to pick some. */
export interface DiscoverSeasonDetails {
  seasonNumber: number;
  name?: string;
  episodes: DiscoverEpisode[];
}

export interface DiscoverEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDate?: string;
  overview?: string;
  stillUrl?: string;
  inLibrary: boolean;
  requested: boolean;
  /** Not out yet: Sonarr downloads it once it is. */
  upcoming: boolean;
}

/** A part of a show to ask for: whole seasons and single episodes (TMDB's numbers). */
export interface RequestParts {
  seasons?: number[];
  episodes?: { seasonNumber: number; episodeNumber: number }[];
}

export interface MediaRequestDto {
  id: string;
  kind: RequestKind;
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
  anime: boolean;
  /** Shows: only these seasons; with `episodes` empty too, the whole show. */
  seasons?: number[];
  /** Shows: single episodes asked for (not those of whole seasons). */
  episodes?: { seasonNumber: number; episodeNumber: number }[];
  status: RequestStatus;
  /** Who asked for it, the first one first. */
  requestedBy: { id: string; displayName: string }[];
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Why an admin declined it, or what Radarr/Sonarr said. */
  reason?: string;
  /** In the library: the title's page. */
  itemId?: string;
  /** In the queue of Radarr or Sonarr now. */
  download?: DownloadProgress;
}

/** Where Radarr or Sonarr puts a new title, and in which quality. */
export interface ArrTarget {
  rootFolderPath: string;
  qualityProfileId: number;
}

export interface ArrServerInfo {
  configured: boolean;
  /** It answered with its API key. */
  ok: boolean;
  version?: string;
  error?: string;
  rootFolders: { path: string; freeSpace?: number }[];
  qualityProfiles: { id: number; name: string }[];
}

/** Admins: Beheer → Verzoeken. */
export interface RequestsConfig {
  radarr: ArrServerInfo;
  sonarr: ArrServerInfo;
  /** Requests from members go to Radarr/Sonarr at once (an admin's always do). */
  autoApprove: boolean;
  movies?: ArrTarget;
  shows?: ArrTarget;
  anime?: ArrTarget;
}

/** Beheer → Gezondheid: how a part of the server is doing. */
export type HealthLevel = 'ok' | 'warning' | 'error' | 'unknown';

export interface HealthCheck {
  /** "media-folders", "media-disk", "cache-disk", "transcode-disk", "transcoder", "backup", "scan", "certificate", "radarr", "sonarr", "attention". */
  id: string;
  label: string;
  level: HealthLevel;
  /** One line, in Dutch. */
  detail: string;
  /** What to do about it, when not ok. */
  hint?: string;
  /** Since when it is not ok (ISO). */
  since?: string;
}

/** GET /api/admin/health. */
export interface HealthReport {
  checkedAt: string;
  /** The worst of the checks (unknown counts as ok). */
  level: HealthLevel;
  checks: HealthCheck[];
}

/** POST /api/admin/health/backup: scripts\backup.ps1 after each backup. */
export interface BackupReport {
  file: string;
  size: number;
  /** When it was made (ISO); now when left out. */
  at?: string;
}
