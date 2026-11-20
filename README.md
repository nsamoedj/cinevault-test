# CineVault

Self-hosted streaming app for a personal media library, with hardware transcoding
(Intel QSV) on an N100 mini PC. Web app and Android app (Expo) on the same REST API; iOS later.

See [CLAUDE.md](CLAUDE.md) for decisions, architecture and roadmap.

## Layout

```
apps/api/         Fastify + Prisma API: scanner, metadata (TMDB/TVmaze), image cache, streaming
apps/transcoder/  FFmpeg + Intel QSV, runs natively on Windows (no npm dependencies)
apps/web/         React + Vite web app, served by Caddy (which also forwards /api)
apps/mobile/      Expo (React Native) Android app, built as an APK by GitHub Actions
packages/shared/  Types, API client and playback logic shared by API, web and mobile
scripts/          PowerShell tools: up, scan, transcoder, backup, public access, setup check, QSV check, Android key and APKs
assets/branding/  Logos
```

## Running on the server (N100, Windows)

The N100 runs Windows with Docker Desktop. The API and PostgreSQL run in Docker; hardware
transcoding will run natively on Windows (Docker Desktop can't pass an Intel GPU through).
Full step-by-step guide (Dutch): [docs/server-setup.md](docs/server-setup.md).

1. Check that Quick Sync works (needs FFmpeg: `winget install Gyan.FFmpeg`):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\check-qsv.ps1
   ```

2. Configure and start:

   ```powershell
   Copy-Item .env.example .env    # fill in passwords and paths (D:/Media style)
   powershell -ExecutionPolicy Bypass -File .\scripts\up.ps1
   ```

   `up.ps1` builds the `cinevault-api` and `cinevault-web` images with `docker build`,
   starts the stack, waits for the API and the web interface, and prints the address
   (default <http://localhost:8765>). With `PUBLIC_DOMAIN` in `.env` Caddy also serves
   `https://<domain>` with a Let's Encrypt certificate (ports 80/443, `scripts\public-access.ps1`,
   `docs/server-setup.md` step 20). The API port itself is only published on 127.0.0.1. `docker compose up --build` doesn't work on Windows here: Compose's Bake
   builder rejects `apps\api\Dockerfile` ("additional privileges requested"). The API
   container applies pending database migrations on every start.

## API

All under `/api`. Types: `packages/shared`.

Everything except `/health`, `/auth/status`, `/auth/setup` and `/auth/login` needs a
login: the `cinevault_session` cookie (web) or `Authorization: Bearer <token>` (the token
from login, for Expo; or `API_TOKEN` from `.env`, for scripts, as admin without progress).
Marked _admin_: only for admins.

| Method      | Path                                          |                                                                                                        |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET         | `/health`                                     | API and database status, and the commit the image was built from                                       |
| GET         | `/auth/status`                                | `{ setupRequired, user? }`: is there an account, who is logged in                                      |
| POST        | `/auth/setup`                                 | the first account (admin), only while there is none                                                    |
| POST        | `/auth/login`, `/auth/logout`                 | log in (`{ username, password }`, sets the cookie) / out                                               |
| GET, PATCH  | `/auth/me`                                    | your account / change name, colour or password                                                         |
| GET, POST   | `/users`                                      | _admin_: accounts of the household / add one                                                           |
| PATCH, DEL  | `/users/:id`                                  | _admin_: role, colour, new password / delete an account                                                |
| PUT         | `/progress/:fileId`                           | where this profile is (`{ positionMs, durationMs? }`)                                                  |
| GET         | `/continue`                                   | "Verder kijken": halfway titles and next episodes                                                      |
| GET         | `/my-list`                                    | "Mijn lijst" of the signed-in profile, the last added first                                            |
| PUT, DELETE | `/my-list/:itemId`                            | add a title to the list / take it off                                                                  |
| GET         | `/calendar?scope=following\|all`              | "Agenda": episodes from a week ago on, of followed shows or all                                        |
| GET, POST   | `/calendar/link`                              | the profile's secret calendar link / a new one (the old one stops)                                     |
| GET         | `/calendar/ics/<token>.ics`                   | the iCalendar feed behind that link, without a login                                                   |
| GET         | `/notifications`                              | the inbox (delivered ones, newest first) and the number unread; `?limit=`                              |
| POST        | `/notifications/read`                         | `{ ids }` or `{ all: true }`                                                                           |
| GET, PUT    | `/notifications/settings`                     | which notifications this profile gets, and quiet hours                                                 |
| GET         | `/notifications/push/key`                     | the server's web push (VAPID) key                                                                      |
| POST        | `/notifications/push`, `…/push/remove`        | subscribe / unsubscribe this browser for web push (HTTPS only)                                         |
| POST        | `/notifications/test`                         | a test notification for yourself                                                                       |
| GET         | `/discover`                                   | "Ontdekken": rows of new and trending titles on TMDB (first page each), with what is here or asked for |
| GET         | `/discover/rows/:id`                          | one row, page by page; `?page=`                                                                        |
| GET         | `/discover/search`                            | movies and shows on TMDB at once; `?q=&page=`                                                          |
| GET         | `/discover/:kind/:tmdbId`                     | a title's details: genres, length, trailer, cast; shows also their seasons (`seasonList`)              |
| GET         | `/discover/show/:tmdbId/season/:n`            | a season's episodes, with what is here, asked for, or not out yet                                      |
| GET         | `/requests/search`                            | "Verzoeken": titles on TMDB to ask for, with what is here or asked for; `?q=&kind=movie\|show`         |
| GET, POST   | `/requests`                                   | all requests / ask for a title (`{ kind, tmdbId, anime?, seasons?, episodes? }`)                       |
| POST        | `/requests/:id/approve`, `…/decline`          | _admin_: send it to Radarr/Sonarr (`{ anime? }`) / decline it (`{ reason? }`)                          |
| DELETE      | `/requests/:id`                               | withdraw your own waiting request; _admin_: any                                                        |
| GET, PUT    | `/requests/config`                            | _admin_: the Radarr/Sonarr connections, folders, quality and "approve at once"                         |
| PUT         | `/items\|seasons\|episodes/:id/watched`       | mark watched or not (`{ watched }`)                                                                    |
| GET, POST   | `/libraries`                                  | list / _admin_: add a library (a folder inside MEDIA_ROOT)                                             |
| DELETE      | `/libraries/:id`                              | _admin_: remove a library from CineVault (files untouched)                                             |
| GET, POST   | `/scan`                                       | scan status / start a scan (_admin_; `{ libraryId?, refresh… }`)                                       |
| GET         | `/home`                                       | start page: billboard (with what to play), new episodes, new movies, "because you watched", rows       |
| GET         | `/search`                                     | all libraries; `?q=`, `?limit=`                                                                        |
| GET         | `/libraries/:id/genres`                       | the genres in a library, the most common first                                                         |
| GET         | `/libraries/:id/items`                        | titles; `?search=`, `?sort=title\|added\|year\|rating`, `?genre=`, `?status=`, `?page=`                |
| GET         | `/items/:id`                                  | details with seasons, episodes, files and tracks                                                       |
| GET         | `/items/:id/similar`                          | "More like this": TMDB recommendations in the library, then shared genres                              |
| GET         | `/items/:id/theme`                            | Theme music of a show: Plex's theme (tvthemes.plexapp.com), cached (`ThemeInfo`)                       |
| GET         | `/items/:id/theme.mp3`                        | The theme music itself (MP3, with range requests)                                                      |
| PUT         | `/items/:id/theme`                            | _admin_: theme music off or on for a title (`{ off }`)                                                 |
| PUT         | `/items/:id/tracks`                           | Remembers audio (`audioLanguage`) or subtitles (`subtitle`, `"off"`) for a show, per profile           |
| GET         | `/files/:id/thumbnails`                       | Timeline previews (`ThumbnailInfo`): sheets of 5 × 5 pictures, `pending` until made                    |
| GET         | `/files/:id/thumbnails/:version/:n.jpg`       | One sheet of previews (JPEG)                                                                           |
| GET         | `/items/:id/candidates`                       | _admin_: results for a manual match; `?title=&year=`                                                   |
| PUT, DELETE | `/items/:id/match`                            | _admin_: set (`{ provider, id }`, locked) / undo a match                                               |
| GET         | `/images/:scheme/*`                           | cached posters and backdrops                                                                           |
| GET         | `/files/:id`                                  | a file with its title/episode, your progress and the next episode                                      |
| GET, HEAD   | `/files/:id/stream`                           | direct play with HTTP range requests                                                                   |
| GET         | `/stats/codecs`                               | containers, codecs, resolutions, HDR across the library                                                |
| POST        | `/playback`                                   | start an HLS session (remux or transcode), see `PlaybackRequest`                                       |
| GET, DELETE | `/playback/:id`                               | session status (keeps it alive) / stop it                                                              |
| GET         | `/playback/:id/:file`                         | `index.m3u8`, `init.mp4`, `seg_00000.m4s` from the transcoder                                          |
| GET         | `/files/:id/picture`                          | black bars baked into the frame (`PictureInfo`), found once by the transcoder                          |
| GET         | `/files/:id/intro`                            | Skip Intro, end credits and recap (`IntroInfo`), or `pending` while the server looks                   |
| PUT, DELETE | `/files/:id/intro`, `…/credits`, `…/recap`    | _admin_: set the intro, credits or recap by hand (`{ startMs, endMs }`), or "this file has none"       |
| POST        | `/files/:id/intro/detect`, `…/credits/detect` | _admin_: look again (forgets what was set by hand); also `…/recap/detect`                              |
| GET         | `/intro/status`                               | _admin_: how far the intro, credits and recap search is (`IntroStatus`)                                |
| POST        | `/hooks/arr?token=`                           | Sonarr/Radarr webhook (`WEBHOOK_TOKEN`, no login): scan the library of a download                      |
| POST        | `/auth/device`, `/auth/device/poll`           | a TV: a code to log in with on a phone, and asking until it is confirmed (no login)                    |
| GET, POST   | `/auth/device/:code`, `…/approve`             | the phone: which device asks, and log it in as me                                                      |
| POST        | `/cast/token`                                 | links for a Chromecast to one playback session (`CastLink`), valid 12 hours                            |
| GET         | `/cast/:token/…`                              | without login, with CORS: the session's HLS files, `subtitles/:id/track.vtt`, `poster`                 |
| GET         | `/transcoder`                                 | whether the transcoder is reachable, QSV, tone mapping, load                                           |
| GET         | `/files/:id/subtitles`                        | subtitles of a file: embedded tracks, files next to it, downloads                                      |
| GET         | `/subtitles/:id/vtt`                          | a whole subtitle as WebVTT                                                                             |
| PUT         | `/files/:id/subtitles/:subtitleId/offset`     | time shift (`{ offsetMs }`), also for `embedded:<index>`                                               |
| POST        | `/files/:id/subtitles/extract`                | read an embedded track from `{ streamIndex, start }`                                                   |
| GET, DELETE | `/subtitle-extractions/:id`                   | WebVTT read so far (`x-covered`, `x-complete`) / stop                                                  |
| GET         | `/files/:id/subtitles/search`                 | OpenSubtitles; `?languages=nld,eng`                                                                    |
| POST        | `/files/:id/subtitles/download`               | download a search result (`{ id }`) into the cache                                                     |
| POST        | `/files/:id/subtitles/ocr`                    | read a picture subtitle (PGS, English or Dutch) as text (`{ streamIndex }`); then a text subtitle      |
| DELETE      | `/subtitles/:id`                              | _admin_: remove a downloaded subtitle                                                                  |

Back up the database: `scripts\backup.ps1` (step 18). Scan from PowerShell: `scripts\scan.ps1` (see `docs/server-setup.md`, step 12). Accounts:
step 16.

## Development

Requires Node.js 22.12+ and pnpm (`corepack enable`).

```sh
pnpm install                 # also generates the Prisma client
cp .env.example .env         # DATABASE_URL must point at a reachable PostgreSQL 16
pnpm --filter @cinevault/shared build
pnpm --filter @cinevault/api prisma:migrate   # create/apply migrations
pnpm dev:api                 # http://localhost:3000/api/health
pnpm dev:web                 # http://localhost:5173, forwards /api to :3000
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`.

The scanner integration tests need a PostgreSQL database they may wipe; they are skipped
unless `TEST_DATABASE_URL` is set:

```sh
TEST_DATABASE_URL=postgresql://cinevault:devpass@localhost:5432/cinevault_test pnpm test
```

The ffprobe and transcoder tests run when `ffmpeg`/`ffprobe` are on the PATH. Run the
transcoder locally (on the CPU) with
`TRANSCODER_HWACCEL=none pnpm --filter @cinevault/transcoder start`; it reads `.env`.

Browser tests (Playwright, Chromium) start the real API with ffprobe on generated videos
(fake TMDB), the transcoder on the CPU and the built web app:

```sh
E2E_DATABASE_URL=postgresql://cinevault:devpass@localhost:5432/cinevault_e2e pnpm --filter @cinevault/web e2e
# or against a running stack: E2E_BASE_URL=http://localhost:8765 pnpm --filter @cinevault/web e2e
```

### Android app

`.github/workflows/android.yml` builds two release APKs on every change to `apps/mobile` or
`packages/shared` and publishes them as the pre-release `android-latest`: `CineVault.apk`
(arm64, phones) and `CineVault-TV.apk` (also 32-bit, for Android TV). It is one app: on a TV
(`Platform.isTV`) it shows the screens in `src/tv/`, for the remote. `scripts\get-apk.ps1`
puts both on the N100, where Caddy serves them at `/tv` and `/android`. Installing, connecting
and the signing key (Dutch): [docs/android.md](docs/android.md).

```sh
cd apps/mobile
pnpm exec expo prebuild --platform android --no-install --clean   # android/ is not in git
cd android && ./gradlew assembleRelease                           # JDK 17 + Android SDK
```
