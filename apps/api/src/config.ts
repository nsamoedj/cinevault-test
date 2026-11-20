import { z } from 'zod';

// Empty values in .env (e.g. `TMDB_API_KEY=`) mean "not set".
const optionalString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const booleanString = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((value) => value === 'true' || value === '1');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MEDIA_ROOT: z.string().default('/media'),
  /** Downloaded images and other things CineVault keeps itself. */
  CACHE_DIR: z.string().default('/cache'),
  /** TMDB language for details, e.g. "nl-NL" (owner's choice) or "en-US"; empty texts fall back to English. */
  METADATA_LANGUAGE: z
    .string()
    .optional()
    .transform((value) => value || 'nl-NL')
    .pipe(
      z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'METADATA_LANGUAGE must look like en-US or nl-NL'),
    ),
  FFPROBE_PATH: z.string().default('ffprobe'),
  /** Copies picture subtitles (PGS) out of a file, to read them as text. */
  FFMPEG_PATH: z.string().default('ffmpeg'),
  /** Read picture subtitles (PGS) as text, with Tesseract. On unless "false". */
  SUBTITLE_OCR: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  /** The transcoder (apps/transcoder), the container next to the API in docker-compose.yml. */
  TRANSCODER_URL: z.url().default('http://transcoder:8766'),
  /** Shared secret with the transcoder; without it there is no transcoding. */
  TRANSCODER_TOKEN: optionalString,
  /** Scan all libraries when the API starts. */
  SCAN_ON_STARTUP: booleanString,
  /**
   * Scan for new and changed files this often, so new downloads show up on
   * the start page; 0 turns it off. Unchanged files are not read again.
   */
  SCAN_INTERVAL_MINUTES: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(0).max(10_080).default(60),
  ),
  /**
   * Skip Intro for anime: openings and endings from AniSkip (api.aniskip.com),
   * matched to MyAnimeList with the Fribb anime-lists. On unless "false".
   */
  ANISKIP: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  /**
   * "Ontdekken": anime rows and anime in searches from AniList
   * (graphql.anilist.co), shown as their TMDB titles. On unless "false".
   */
  ANILIST: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  /**
   * Theme music: the show themes Plex uses (tvthemes.plexapp.com, by TVDB id),
   * fetched once and kept in CACHE_DIR/themes. On unless "false".
   */
  PLEX_THEMES: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  /**
   * Theme music for anime Plex has none for: the first opening on AnimeThemes
   * (animethemes.moe, by MyAnimeList id via the anime-lists). On unless "false".
   */
  ANIME_THEMES: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  /**
   * Theme music for shows the others have none for: ThemerrDB's YouTube link
   * (by TMDB id), downloaded with yt-dlp. On unless "false".
   */
  THEMERRDB: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  /** A yt-dlp to use as it is; without it the API keeps (and updates) its own copy in CACHE_DIR/bin. */
  YTDLP_PATH: optionalString,
  TMDB_API_KEY: optionalString,
  OPENSUBTITLES_API_KEY: optionalString,
  /** Optional OpenSubtitles account: a higher daily download limit than without. */
  OPENSUBTITLES_USERNAME: optionalString,
  OPENSUBTITLES_PASSWORD: optionalString,
  /** Signs login tokens. scripts/up.sh creates one; without it, logins end at every restart. */
  JWT_SECRET: optionalString,
  /**
   * Where a Chromecast reaches the server, e.g. http://192.168.0.110:8765 (the
   * LAN address). Without it, casting uses the address the phone used.
   */
  CAST_BASE_URL: z
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** For scripts on the server (scan.sh, verify-setup.sh): acts as an admin. */
  API_TOKEN: optionalString,
  /** For Sonarr and Radarr (POST /api/hooks/arr): it can only start a scan. */
  WEBHOOK_TOKEN: optionalString,
  /** Local time for notifications: quiet hours (23:00-08:00) and "airs today". */
  NOTIFY_TIMEZONE: z
    .string()
    .optional()
    .transform((value) => value || 'Europe/Amsterdam')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'NOTIFY_TIMEZONE must be a time zone like Europe/Amsterdam'),
  /**
   * "Verzoeken": Radarr and Sonarr, to add asked-for titles to. Without an API
   * key there are no requests for that kind. From the API container, the
   * Windows host is host.docker.internal.
   */
  RADARR_URL: z.url().default('http://host.docker.internal:7878'),
  RADARR_API_KEY: optionalString,
  SONARR_URL: z.url().default('http://host.docker.internal:8989'),
  SONARR_API_KEY: optionalString,
  /** e.g. cine-vault.nl: web push names it as the sender (VAPID). */
  PUBLIC_DOMAIN: optionalString,
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
