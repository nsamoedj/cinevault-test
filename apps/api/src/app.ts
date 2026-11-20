import { installKidsGuard } from './kids.js';
import { readFileSync } from 'node:fs';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { ZodError } from 'zod';
import { installAuth } from './auth/plugin.js';
import type { LoginThrottle } from './auth/throttle.js';
import type { ImageCache } from './images.js';
import { authRoutes } from './routes/auth.js';
import { castRoutes } from './routes/cast.js';
import { hookRoutes } from './routes/hooks.js';
import type { ScanQueue } from './scanQueue.js';
import { healthRoutes } from './routes/health.js';
import { collectionRoutes } from './routes/collections.js';
import { homeRoutes } from './routes/home.js';
import { imageRoutes } from './routes/images.js';
import { libraryRoutes, type LibraryRoutesOptions } from './routes/library.js';
import { calendarRoutes } from './routes/calendar.js';
import { myListRoutes } from './routes/myList.js';
import { notificationRoutes } from './routes/notifications.js';
import { removeRoutes } from './routes/remove.js';
import { requestRoutes } from './routes/requests.js';
import { ArrError } from './requests/arr.js';
import { DiscoverService } from './requests/discover.js';
import { RemoveError, type RemoveService } from './requests/remove.js';
import { RequestError, type RequestService } from './requests/service.js';
import type { NotificationEvents } from './notifications/events.js';
import type { NotificationService } from './notifications/service.js';
import { playbackRoutes } from './routes/playback.js';
import { progressRoutes } from './routes/progress.js';
import { streamRoutes } from './routes/stream.js';
import { trackRoutes } from './routes/tracks.js';
import { subtitleRoutes } from './routes/subtitles.js';
import { SubtitleError, type SubtitleService } from './subtitles/service.js';
import { SubtitleProviderError } from './subtitles/types.js';
import { type TranscoderClient, TranscoderError } from './transcoder.js';
import type { IntroService } from './intro/service.js';
import { adminHealthRoutes } from './routes/adminHealth.js';
import { introRoutes } from './routes/intro.js';
import { themeRoutes } from './routes/themes.js';
import { thumbnailRoutes } from './routes/thumbnails.js';
import type { ThemeService } from './themes/service.js';
import type { ThumbnailService } from './thumbnails.js';
import type { HealthService } from './health.js';

// Works from both src/ (tsx) and dist/ (node): package.json is one level up.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
// Set at image build time by scripts/up.sh (or up.ps1).
const commit = process.env.GIT_COMMIT || undefined;

export interface AppServices extends LibraryRoutesOptions {
  images: ImageCache;
  /** The native transcoder; undefined when TRANSCODER_TOKEN is not set. */
  transcoder?: TranscoderClient;
  subtitles?: SubtitleService;
  /** CACHE_DIR, for what the API keeps besides images and subtitles. */
  cacheDir?: string;
  /** CAST_BASE_URL: where a Chromecast reaches the server. */
  castBaseUrl?: string;
  /** Skip Intro: the intro search; without it there are no intros. */
  intro?: IntroService;
  /** Theme music on the detail pages of shows. */
  themes?: ThemeService;
  /** Preview pictures for the players' timelines. */
  thumbnails?: ThumbnailService;
  /** Scans asked for by Sonarr and Radarr (POST /hooks/arr), with WEBHOOK_TOKEN. */
  scanQueue?: ScanQueue;
  webhookToken?: string;
  /** The inbox and web push; without it there are no notifications. */
  notifications?: NotificationService;
  /** What gives a notification (a new login, in the auth routes). */
  notificationEvents?: NotificationEvents;
  /** "Verzoeken": titles asked for, added to Radarr and Sonarr. */
  requests?: RequestService;
  /** "Ontdekken": TMDB's new titles to browse (made from `requests` when left out). */
  discover?: DiscoverService;
  /** Removing titles through Radarr and Sonarr (admins). */
  remove?: RemoveService;
  /** https://PUBLIC_DOMAIN, for links that leave the app (the calendar feed). */
  publicBaseUrl?: string;
  /** NOTIFY_TIMEZONE: what "today" is for the calendar (Europe/Amsterdam when left out). */
  timeZone?: string;
  /** Beheer → Gezondheid. */
  health?: HealthService;
}

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  /** A ready logger (shared with the scanner); takes precedence over `logger`. */
  loggerInstance?: FastifyBaseLogger;
  checkDatabase: () => Promise<void>;
  /** Library, scan, item and image routes; left out in tests that only need health. */
  services?: AppServices;
  /** Login for every route but health and login itself; required with `services`. */
  auth?: { jwtSecret: string; apiToken?: string; throttle?: LoginThrottle; now?: () => number };
}

/** Cast tokens travel in the path (routes/cast.ts) and are longer than Fastify's 100. */
const MAX_PARAM_LENGTH = 600;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = options.loggerInstance
    ? Fastify({ loggerInstance: options.loggerInstance, maxParamLength: MAX_PARAM_LENGTH })
    : Fastify({ logger: options.logger ?? false, maxParamLength: MAX_PARAM_LENGTH });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'invalid request',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (error instanceof TranscoderError) {
      // Tell the player why: not configured, not reachable, queued, failed.
      if (error.statusCode >= 500) request.log.warn({ err: error }, 'transcoder error');
      if (error.statusCode === 503) reply.header('retry-after', '2');
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof RequestError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.message, ...(error.itemId && { itemId: error.itemId }) });
    }
    if (error instanceof RemoveError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    // Radarr or Sonarr refused or is away: say what it said.
    if (error instanceof ArrError) {
      request.log.warn({ err: error }, 'radarr/sonarr error');
      return reply.code(502).send({ error: error.message });
    }
    if (error instanceof SubtitleError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof SubtitleProviderError) {
      // The daily download limit (406/429) is worth telling as such; other
      // provider failures are the server's problem.
      const limit = error.statusCode === 406 || error.statusCode === 429;
      request.log.warn({ err: error }, 'subtitle provider error');
      return reply.code(limit ? 429 : 502).send({ error: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    return reply
      .code(status)
      .send({ error: status >= 500 ? 'internal error' : (error as Error).message });
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { version, commit, checkDatabase: options.checkDatabase });
      if (options.services) {
        if (!options.auth?.jwtSecret) throw new Error('buildApp: auth.jwtSecret is required');
        installAuth(api, { prisma: options.services.prisma, ...options.auth });
        installKidsGuard(api, options.services.prisma);
        await api.register(authRoutes, {
          prisma: options.services.prisma,
          ...(options.auth.throttle && { throttle: options.auth.throttle }),
          ...(options.services.notificationEvents && {
            events: options.services.notificationEvents,
          }),
        });
        await api.register(libraryRoutes, options.services);
        if (options.services.scanQueue) {
          await api.register(hookRoutes, {
            prisma: options.services.prisma,
            queue: options.services.scanQueue,
            ...(options.services.webhookToken && { token: options.services.webhookToken }),
          });
        }
        await api.register(progressRoutes, { prisma: options.services.prisma });
        await api.register(homeRoutes, { prisma: options.services.prisma });
        await api.register(collectionRoutes, { prisma: options.services.prisma });
        await api.register(myListRoutes, { prisma: options.services.prisma });
        await api.register(trackRoutes, { prisma: options.services.prisma });
        await api.register(calendarRoutes, {
          prisma: options.services.prisma,
          timeZone: options.services.timeZone ?? 'Europe/Amsterdam',
          ...(options.services.publicBaseUrl && { baseUrl: options.services.publicBaseUrl }),
        });
        if (options.services.requests) {
          await api.register(requestRoutes, {
            requests: options.services.requests,
            discover:
              options.services.discover ??
              new DiscoverService({ requests: options.services.requests }),
          });
        }
        if (options.services.remove) {
          await api.register(removeRoutes, { remove: options.services.remove });
        }
        if (options.services.notifications) {
          await api.register(notificationRoutes, {
            prisma: options.services.prisma,
            notifications: options.services.notifications,
          });
        }
        await api.register(imageRoutes, { images: options.services.images });
        const intro = options.services.intro;
        if (intro) {
          // Watching keeps the intro search off the disks.
          api.addHook('onRequest', async (request) => {
            if (/^\/api\/(files\/[^/]+\/stream|playback\/|cast\/)/.test(request.url)) {
              intro.activity.touch();
            }
          });
          await api.register(introRoutes, { prisma: options.services.prisma, intro });
        }
        if (options.services.thumbnails) {
          await api.register(thumbnailRoutes, { thumbnails: options.services.thumbnails });
        }
        if (options.services.health) {
          await api.register(adminHealthRoutes, { health: options.services.health });
        }
        if (options.services.themes) {
          await api.register(themeRoutes, {
            prisma: options.services.prisma,
            themes: options.services.themes,
          });
        }
        await api.register(streamRoutes, {
          prisma: options.services.prisma,
          mediaRoot: options.services.mediaRoot,
          ...(intro && { intro }),
        });
        if (options.services.subtitles) {
          await api.register(subtitleRoutes, { subtitles: options.services.subtitles });
        }
        await api.register(playbackRoutes, {
          prisma: options.services.prisma,
          ...(options.services.transcoder && { transcoder: options.services.transcoder }),
          ...(options.services.cacheDir && { cacheDir: options.services.cacheDir }),
        });
        await api.register(castRoutes, {
          prisma: options.services.prisma,
          images: options.services.images,
          jwtSecret: options.auth.jwtSecret,
          ...(options.services.transcoder && { transcoder: options.services.transcoder }),
          ...(options.services.subtitles && { subtitles: options.services.subtitles }),
          ...(options.services.castBaseUrl && { castBaseUrl: options.services.castBaseUrl }),
          ...(options.auth.now && { now: options.auth.now }),
        });
      }
    },
    { prefix: '/api' },
  );

  return app;
}
