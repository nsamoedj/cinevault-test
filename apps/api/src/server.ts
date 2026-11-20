import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './db.js';
import { ImageCache } from './images.js';
import { ensureDefaultLibraries } from './libraries.js';
import { MetadataService } from './metadata/service.js';
import { TmdbProvider } from './metadata/tmdb.js';
import { TvmazeProvider } from './metadata/tvmaze.js';
import { createProber } from './scanner/probe.js';
import { CollectionService } from './collections.js';
import { HealthService } from './health.js';
import { ScanQueue } from './scanQueue.js';
import { Scanner } from './scanner/scanner.js';
import { OpenSubtitlesProvider } from './subtitles/opensubtitles.js';
import { TesseractEngine } from './subtitles/ocr.js';
import { SubtitleService } from './subtitles/service.js';
import { TranscoderClient } from './transcoder.js';
import { AniSkip } from './intro/aniskip.js';
import { IntroService } from './intro/service.js';
import { AnimeThemesProvider } from './themes/animethemes.js';
import { PlexThemeProvider, ThemeService } from './themes/service.js';
import { ThemerrDbProvider, YtDlp } from './themes/themerr.js';
import { ThumbnailService } from './thumbnails.js';
import { NotificationEvents } from './notifications/events.js';
import { WebPushSender } from './notifications/push.js';
import { NotificationService } from './notifications/service.js';
import { AniListClient, AnimeDiscovery } from './requests/anilist.js';
import { RadarrClient, SonarrClient } from './requests/arr.js';
import { DownloadService } from './requests/downloads.js';
import { DiscoverService } from './requests/discover.js';
import { RemoveService } from './requests/remove.js';
import { RequestService } from './requests/service.js';

const config = loadConfig();
const prisma = createPrisma(config.DATABASE_URL);
const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
});

if (!config.TMDB_API_KEY) {
  logger.warn('TMDB_API_KEY is not set: movies stay unmatched, shows use TVmaze only');
}
const tmdb = config.TMDB_API_KEY
  ? new TmdbProvider({ apiKey: config.TMDB_API_KEY, language: config.METADATA_LANGUAGE })
  : undefined;
const metadata = new MetadataService({
  ...(tmdb && { tmdb }),
  tvmaze: new TvmazeProvider(),
});
const images = new ImageCache({ cacheDir: config.CACHE_DIR, mediaRoot: config.MEDIA_ROOT });
// Collecties: the TMDB collections of the films here, fetched after each scan and every 6 hours.
const collections = new CollectionService({ prisma, ...(tmdb && { tmdb }), log: logger });
const scanner = new Scanner({
  prisma,
  mediaRoot: config.MEDIA_ROOT,
  probe: createProber({ ffprobePath: config.FFPROBE_PATH }),
  metadata,
  images,
  logger,
  // New episodes, recommendations and unmatched titles (notifications), and
  // requests that arrived (below).
  onLibraryScanned: async (scan) => {
    // What came in: Skip Intro, the recap and the credits are looked for now.
    void intro.scanned(scan);
    await events.libraryScanned(scan);
    await requests.checkAvailable();
    void collections.refresh().catch(() => {});
  },
});

// Scans asked for by Sonarr/Radarr and the hourly scan, one after the other.
const scanQueue = new ScanQueue(scanner);

if (!config.TRANSCODER_TOKEN) {
  logger.warn('TRANSCODER_TOKEN is not set: only direct play, no transcoding');
}
const transcoder = config.TRANSCODER_TOKEN
  ? new TranscoderClient({ url: config.TRANSCODER_URL, token: config.TRANSCODER_TOKEN })
  : undefined;

if (!config.OPENSUBTITLES_API_KEY) {
  logger.warn('OPENSUBTITLES_API_KEY is not set: no subtitle search');
}
// AniSkip, and its anime-lists (TVDB to MyAnimeList), also for the openings of AnimeThemes.
const aniskip = new AniSkip({ cacheDir: config.CACHE_DIR, log: logger });
// Skip Intro: looks for intros in the background (only with the transcoder).
const intro = new IntroService({
  prisma,
  cacheDir: config.CACHE_DIR,
  ...(transcoder && { transcoder }),
  ...(config.ANISKIP && { aniskip }),
  log: logger,
});

// Theme music: Plex's themes of shows, else the opening of an anime on
// AnimeThemes, else ThemerrDB's YouTube link, fetched once and kept in the cache.
const themes = new ThemeService({
  prisma,
  cacheDir: config.CACHE_DIR,
  providers: [
    ...(config.PLEX_THEMES
      ? [
          new PlexThemeProvider(prisma, {
            ...(tmdb && { tvdbId: (tmdbId: number) => tmdb.tvdbId(tmdbId) }),
          }),
        ]
      : []),
    ...(config.ANIME_THEMES
      ? [
          new AnimeThemesProvider(prisma, {
            animeMap: () => aniskip.animeMap(),
            ffmpeg: config.FFMPEG_PATH,
          }),
        ]
      : []),
    ...(config.THEMERRDB
      ? [
          new ThemerrDbProvider(prisma, {
            youtube: new YtDlp({
              ...(config.YTDLP_PATH && { path: config.YTDLP_PATH }),
              cacheDir: config.CACHE_DIR,
              bundled: '/usr/local/bin/yt-dlp',
              log: logger,
            }),
            ffmpeg: config.FFMPEG_PATH,
          }),
        ]
      : []),
  ],
  log: logger,
});

// Preview pictures for the timeline, made by the transcoder while nobody watches.
const thumbnails = new ThumbnailService({
  prisma,
  cacheDir: config.CACHE_DIR,
  ...(transcoder && { transcoder }),
  idle: () => intro.activity.idle(2 * 60_000),
  log: logger,
});

const subtitles = new SubtitleService({
  prisma,
  mediaRoot: config.MEDIA_ROOT,
  cacheDir: config.CACHE_DIR,
  ...(transcoder && { transcoder }),
  ...(config.OPENSUBTITLES_API_KEY && {
    opensubtitles: new OpenSubtitlesProvider({
      apiKey: config.OPENSUBTITLES_API_KEY,
      ...(config.OPENSUBTITLES_USERNAME && { username: config.OPENSUBTITLES_USERNAME }),
      ...(config.OPENSUBTITLES_PASSWORD && { password: config.OPENSUBTITLES_PASSWORD }),
    }),
  }),
  // Picture subtitles (PGS) as text, while nobody watches or when someone picks one.
  ...(config.SUBTITLE_OCR && {
    ocr: {
      engine: new TesseractEngine(config.CACHE_DIR),
      ffmpeg: config.FFMPEG_PATH,
      idle: () => intro.activity.idle(2 * 60_000),
      log: logger,
    },
  }),
});

// Notifications: the inbox in every app, web push for browsers (over HTTPS),
// and the Android app asks for new ones itself.
const notifications = new NotificationService({
  prisma,
  push: new WebPushSender(
    prisma,
    config.PUBLIC_DOMAIN ? `https://${config.PUBLIC_DOMAIN}` : 'mailto:cinevault@localhost',
  ),
  timeZone: config.NOTIFY_TIMEZONE,
  log: logger,
});
const events = new NotificationEvents(prisma, notifications, config.NOTIFY_TIMEZONE);

// "Verzoeken": asked-for titles go to Radarr and Sonarr.
const radarr = config.RADARR_API_KEY
  ? new RadarrClient({ url: config.RADARR_URL, apiKey: config.RADARR_API_KEY })
  : undefined;
const sonarr = config.SONARR_API_KEY
  ? new SonarrClient({ url: config.SONARR_URL, apiKey: config.SONARR_API_KEY })
  : undefined;
// "Wordt gedownload": their queues.
const downloads = new DownloadService({
  prisma,
  ...(radarr && { radarr }),
  ...(sonarr && { sonarr }),
  log: logger,
});
const requests = new RequestService({
  prisma,
  ...(tmdb && { tmdb }),
  ...(radarr && { radarr }),
  ...(sonarr && { sonarr }),
  notifications,
  downloads,
  log: logger,
});
// "Ontdekken": anime from AniList, as TMDB titles (the anime-lists of AniSkip, else a TMDB search).
const anime = config.ANILIST
  ? new AnimeDiscovery({
      client: new AniListClient(),
      animeMap: () => aniskip.animeMap(),
      tmdb: () => tmdb,
      log: logger,
    })
  : undefined;
const discover = new DiscoverService({ requests, ...(anime && { anime }), log: logger });
const remove = new RemoveService({
  prisma,
  ...(radarr && { radarr }),
  ...(sonarr && { sonarr }),
  scanQueue,
  log: logger,
});

// Beheer → Gezondheid: disks, back-ups, the transcoder, scans, the certificate, Radarr and Sonarr.
const health = new HealthService({
  prisma,
  mediaRoot: config.MEDIA_ROOT,
  cacheDir: config.CACHE_DIR,
  ...(transcoder && { transcoder }),
  scan: () => scanner.getStatus(),
  scanIntervalMinutes: config.SCAN_INTERVAL_MINUTES,
  ...(config.PUBLIC_DOMAIN && { publicDomain: config.PUBLIC_DOMAIN }),
  ...(radarr && { radarr }),
  ...(sonarr && { sonarr }),
  ...(config.CAST_BASE_URL && { castBaseUrl: config.CAST_BASE_URL }),
  notifications,
  log: logger,
});

let jwtSecret = config.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  logger.warn(
    'JWT_SECRET is missing or short: using a temporary one, everyone is logged out at each restart (scripts/up.sh creates one)',
  );
  jwtSecret = randomBytes(48).toString('base64url');
}

const app = await buildApp({
  auth: {
    jwtSecret,
    ...(config.API_TOKEN && config.API_TOKEN.length >= 32 && { apiToken: config.API_TOKEN }),
  },
  loggerInstance: logger,
  checkDatabase: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
  services: {
    prisma,
    scanner,
    scanQueue,
    ...(config.WEBHOOK_TOKEN &&
      config.WEBHOOK_TOKEN.length >= 32 && {
        webhookToken: config.WEBHOOK_TOKEN,
      }),
    metadata,
    images,
    mediaRoot: config.MEDIA_ROOT,
    ...(transcoder && { transcoder }),
    subtitles,
    cacheDir: config.CACHE_DIR,
    ...(config.CAST_BASE_URL && { castBaseUrl: config.CAST_BASE_URL }),
    ...(config.PUBLIC_DOMAIN && { publicBaseUrl: `https://${config.PUBLIC_DOMAIN}` }),
    timeZone: config.NOTIFY_TIMEZONE,
    intro,
    themes,
    thumbnails,
    notifications,
    notificationEvents: events,
    requests,
    remove,
    discover,
    downloads,
    health,
  },
});

app.addHook('onClose', async () => {
  intro.stop();
  themes.stop();
  thumbnails.stop();
  health.stop();
  collections.stop();
  await subtitles.ocr?.stop();
  await prisma.$disconnect();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await prisma.$disconnect();
  process.exit(1);
}

try {
  const created = await ensureDefaultLibraries(prisma, config.MEDIA_ROOT);
  if (created.length > 0) logger.info({ libraries: created }, 'created libraries');
} catch (error) {
  logger.error({ err: error }, 'could not create default libraries');
}
if (config.SCAN_ON_STARTUP) scanner.start();
if (config.SCAN_INTERVAL_MINUTES > 0) {
  // Waits for a scan that is still running (the queue starts it after).
  setInterval(() => scanQueue.request(), config.SCAN_INTERVAL_MINUTES * 60_000).unref();
}
if (transcoder || config.ANISKIP) intro.start();
themes.start();
health.start();
collections.start();
if (transcoder) thumbnails.start();
subtitles.ocr?.start();

const warn = (what: string) => (error: unknown) => logger.warn({ err: error }, what);
// Push messages that waited for the morning (quiet hours).
setInterval(() => void notifications.dispatch(), 60_000).unref();
setInterval(() => {
  events.airingToday().catch(warn('airing notifications failed'));
  notifications.cleanup().catch(warn('notification cleanup failed'));
}, 15 * 60_000).unref();
if (transcoder) {
  setInterval(() => {
    transcoder
      .health()
      .then(
        (health) => events.transcoderChecked(health.ok),
        () => events.transcoderChecked(false),
      )
      .catch(warn('transcoder check failed'));
  }, 5 * 60_000).unref();
}
