// API for the browser tests: the real API, scanner and ffprobe on generated
// videos, against PostgreSQL (E2E_DATABASE_URL, wiped on start), plus the
// real transcoder (on the CPU). TMDB/TVmaze are faked so the tests need no
// network.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../api/src/app.js';
import { createPrisma } from '../../api/src/db.js';
import { ImageCache } from '../../api/src/images.js';
import { ensureDefaultLibraries } from '../../api/src/libraries.js';
import { MetadataService } from '../../api/src/metadata/service.js';
import type {
  Candidate,
  ExternalIds,
  ItemMetadata,
  MovieProvider,
  SearchQuery,
  ShowMetadata,
  ShowProvider,
} from '../../api/src/metadata/types.js';
import { createProber } from '../../api/src/scanner/probe.js';
import { Scanner } from '../../api/src/scanner/scanner.js';
import { TesseractEngine } from '../../api/src/subtitles/ocr.js';
import { SubtitleService } from '../../api/src/subtitles/service.js';
import type { SubtitleProvider } from '../../api/src/subtitles/types.js';
import { TranscoderClient } from '../../api/src/transcoder.js';
import { HealthService } from '../../api/src/health.js';
import { IntroService } from '../../api/src/intro/service.js';
import { PlexThemeProvider, ThemeService } from '../../api/src/themes/service.js';
import { ThumbnailService } from '../../api/src/thumbnails.js';
import { NotificationEvents } from '../../api/src/notifications/events.js';
import { WebPushSender } from '../../api/src/notifications/push.js';
import { NotificationService } from '../../api/src/notifications/service.js';
import { RadarrClient, SonarrClient } from '../../api/src/requests/arr.js';
import { RemoveService } from '../../api/src/requests/remove.js';
import { type RequestTmdb, RequestService } from '../../api/src/requests/service.js';
import { textPicture, writeSup } from '../../api/test/pgs-helpers.js';
import { demoById, demoByTitle, demoSeasons, drawDemoArt, placeDemoFiles } from './demo.js';

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (a database the tests may wipe)');
const port = Number(process.env.E2E_API_PORT ?? 3100);
const transcoderPort = port + 1;
const token = 'e2e-transcoder-token-0123456789';
// Scripts use a token; the browser logs in (e2e/global-setup.ts).
const apiToken = 'e2e-api-token-0123456789abcdef-0123456789';

const dir = mkdtempSync(path.join(tmpdir(), 'cinevault-e2e-'));
const media = path.join(dir, 'media');

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

function video(
  rel: string,
  kind: 'vp9-opus' | 'vp9-eac3' | 'hevc-eac3',
  seconds: number,
  subtitles?: string,
) {
  const file = path.join(media, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  // An embedded English SRT track (stream 2), from a file made here; a .sup
  // is a PGS track (-copyts keeps its lines at their own times).
  const subtitleArgs = subtitles?.endsWith('.sup')
    ? [
        '-copyts',
        '-i',
        subtitles,
        '-map',
        '0',
        '-map',
        '1',
        '-map',
        '2',
        '-c:s',
        'copy',
        '-metadata:s:s:0',
        'language=eng',
      ]
    : subtitles
      ? [
          '-i',
          subtitles,
          '-map',
          '0',
          '-map',
          '1',
          '-map',
          '2',
          '-c:s',
          'subrip',
          '-metadata:s:s:0',
          'language=eng',
        ]
      : [];
  const vp9 = [
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-b:v',
    '300k',
    '-g',
    '25',
  ];
  // prettier-ignore
  const codecs = kind === 'vp9-opus'
    ? [...vp9, '-c:a', 'libopus']
    : kind === 'vp9-eac3'
      ? [...vp9, '-c:a', 'eac3', '-ac', '6']
      : ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-c:a', 'eac3', '-ac', '6'];
  // prettier-ignore
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    ...subtitleArgs, '-t', String(seconds), ...codecs, file,
  ]);
}

const embedded = path.join(dir, 'embedded.srt');
writeFileSync(
  embedded,
  '1\n00:00:00,500 --> 00:00:08,000\nEmbedded line\n\n2\n00:00:08,000 --> 00:00:11,000\nLater line\n',
);
video('Movies/Big Buck Test (2008)/Big Buck Test (2008) WEBDL-1080p.mkv', 'vp9-opus', 12, embedded);
writeFileSync(
  path.join(media, 'Movies/Big Buck Test (2008)/Big Buck Test (2008) WEBDL-1080p.nl.srt'),
  '1\n00:00:00,500 --> 00:00:10,000\nHallo uit een los bestand\n',
);
video('Movies/Unknown Thing (1999)/Unknown Thing (1999).mkv', 'vp9-opus', 2);
video('Series/Heavy Show/Season 1/Heavy Show - S01E01 - Pilot WEBDL-2160p.mkv', 'hevc-eac3', 2);
// Two short episodes, for "Verder kijken" and the next episode.
video('Series/Short Show/Season 1/Short Show - S01E01 - One WEBDL-1080p.mkv', 'vp9-opus', 3);
video('Series/Short Show/Season 1/Short Show - S01E02 - Two WEBDL-1080p.mkv', 'vp9-opus', 3);
// Dolby audio the test browser can't play: the transcoder remuxes it (VP9 kept,
// audio to Opus). With an English PGS track, read as text when asked.
const sup = path.join(dir, 'pictures.sup');
writeFileSync(
  sup,
  writeSup([{ ...textPicture('Pictures as text.'), start: 0.5, end: 9, x: 400, y: 950 }]),
);
video('Movies/Remux Test (2010)/Remux Test (2010) WEBDL-1080p.mkv', 'vp9-eac3', 60, sup);
// Screenshots: a fuller library with artwork (E2E_DEMO=1).
const demo = process.env.E2E_DEMO === '1';
const art = path.join(dir, 'art');
if (demo) {
  drawDemoArt(art);
  placeDemoFiles(
    media,
    path.join(media, 'Series/Short Show/Season 1/Short Show - S01E01 - One WEBDL-1080p.mkv'),
  );
}
const poster = path.join(media, 'Movies/Big Buck Test (2008)/poster.jpg');
ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xE0B04F:s=300x450', '-frames:v', '1', poster]);
const jpeg = readFileSync(poster);

const movie = (id: number, title: string, year: number): ItemMetadata => ({
  provider: 'tmdb',
  id,
  title,
  year,
  overview: `Overzicht van ${title}.`,
  genres: ['Animatie'],
  cast: [{ name: 'Testacteur', character: 'Konijn', order: 0 }],
  backdropRef: 'tmdb:w1280/backdrop.jpg',
  ids: { tmdb: id },
});

const demoMetadata = (id: number): ItemMetadata | undefined => {
  const title = demoById(id);
  if (!title) return undefined;
  return {
    provider: 'tmdb',
    id,
    title: title.title,
    year: title.year,
    overview: title.overview,
    ...(title.tagline && { tagline: title.tagline }),
    genres: title.genres,
    rating: title.rating,
    runtimeMinutes: title.runtime,
    posterRef: `tmdb:w500/p${id}.jpg`,
    backdropRef: `tmdb:w1280/b${id}.jpg`,
    cast: [
      'Mila de Vries',
      'Thomas Bakker',
      'Sanne Jansen',
      'Daan Visser',
      'Noor Smit',
      'Lucas Mulder',
    ].map((name, order) => ({
      name,
      character: `Rol ${order + 1}`,
      order,
      profileRef: 'tmdb:w185/face.jpg',
    })),
    ids: { tmdb: id },
  };
};

class FakeTmdb implements MovieProvider, ShowProvider {
  readonly name = 'tmdb' as const;
  async searchMovies(q: SearchQuery): Promise<Candidate[]> {
    const found = demo ? demoByTitle(q.title) : undefined;
    if (found && !found.seasons) {
      return [{ provider: 'tmdb', id: found.id, title: found.title, year: found.year }];
    }
    if (q.title === 'Big Buck Test')
      return [{ provider: 'tmdb', id: 1, title: 'Big Buck Test', year: 2008 }];
    if (q.title === 'Remux Test')
      return [{ provider: 'tmdb', id: 3, title: 'Remux Test', year: 2010 }];
    if (q.title.startsWith('Unknown'))
      return [{ provider: 'tmdb', id: 2, title: 'Something Else', year: 1999 }];
    return [];
  }
  async getMovie(id: number) {
    if (demo && demoById(id)) return demoMetadata(id);
    if (id === 1) {
      // "Kijken": a title logo, a trailer, and Remux Test as "Meer zoals dit".
      return {
        ...movie(1, 'Big Buck Test', 2008),
        logoRef: 'tmdb:w500/logo.png',
        trailerKey: 'e2eTrailer1',
        recommended: [3, 999],
      };
    }
    if (id === 2) return movie(2, 'Something Else', 1999);
    if (id === 3) return movie(3, 'Remux Test', 2010);
    return undefined;
  }
  async findMovie(ids: ExternalIds) {
    return ids.tmdb;
  }
  async searchShows(q: SearchQuery): Promise<Candidate[]> {
    const found = demo ? demoByTitle(q.title) : undefined;
    if (found?.seasons) return [{ provider: 'tmdb', id: found.id, title: found.title }];
    if (q.title === 'Heavy Show') return [{ provider: 'tmdb', id: 10, title: 'Heavy Show' }];
    if (q.title === 'Short Show') return [{ provider: 'tmdb', id: 11, title: 'Short Show' }];
    return [];
  }
  async getShow(id: number): Promise<ShowMetadata | undefined> {
    const show = demo ? demoById(id) : undefined;
    if (show?.seasons) {
      // "Agenda": the last episode came out lately, the next season is on its way.
      const seasonCount = show.seasons.length;
      const lastCount = show.seasons[seasonCount - 1] ?? 1;
      const date = (days: number) =>
        new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
      const schedule = [
        { season: seasonCount, episode: lastCount, title: 'Finale', airDate: date(-(id % 5) - 1) },
        ...[1, 2, 3].map((n) => ({
          season: seasonCount + 1,
          episode: n,
          title: `Nieuw deel ${n}`,
          overview: `Het vervolg van ${show.title}.`,
          airDate: date((id % 6) + 1 + (n - 1) * 7),
        })),
      ];
      return { ...(demoMetadata(id) as ItemMetadata), schedule, seasons: demoSeasons(show) };
    }
    if (id === 11) {
      return {
        ...movie(11, 'Short Show', 2021),
        // "Binnenkort": episode 3 airs in three days.
        nextEpisode: {
          season: 1,
          episode: 3,
          title: 'Three',
          airDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
        },
        // "Agenda": episode 2 aired yesterday (and is here).
        schedule: [
          {
            season: 1,
            episode: 2,
            title: 'Two',
            airDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
          },
        ],
        seasons: [
          {
            season: 1,
            episodeCount: 2,
            episodes: [
              { season: 1, episode: 1, title: 'One' },
              { season: 1, episode: 2, title: 'Two' },
            ],
          },
        ],
      };
    }
    if (id !== 10) return undefined;
    return {
      ...movie(10, 'Heavy Show', 2020),
      seasons: [
        {
          season: 1,
          episodeCount: 1,
          episodes: [{ season: 1, episode: 1, title: 'Pilot (TMDB)' }],
        },
      ],
    };
  }
  async findShow(ids: ExternalIds) {
    return ids.tmdb;
  }
}

const prisma = createPrisma(databaseUrl);
execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
  cwd: path.resolve(import.meta.dirname, '../../api'),
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'ignore',
});
await prisma.$executeRawUnsafe(
  'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "Subtitle", "WatchProgress", "User", "Session", "Notification", "PushSubscription", "MyListEntry", "AppSetting", "MediaRequest" CASCADE',
);

const metadata = new MetadataService({ tmdb: new FakeTmdb() });
const images = new ImageCache({
  cacheDir: path.join(dir, 'cache'),
  mediaRoot: media,
  // TMDB's images: the demo artwork by name, else the one test image.
  fetch: (async (url: string | URL) => {
    const drawn = path.join(art, path.basename(String(url)));
    const fallback = path.join(art, String(url).includes('w1280') ? 'b101.jpg' : 'p103.jpg');
    const body = !demo ? jpeg : readFileSync(existsSync(drawn) ? drawn : fallback);
    return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch,
});
const silent = { info() {}, warn() {}, error() {} };
const scanner = new Scanner({
  prisma,
  mediaRoot: media,
  probe: createProber(),
  metadata,
  images,
  logger: silent,
});

// The native transcoder, as on Windows but on the CPU. A short burst and real
// time after it, so seeking far ahead needs a new session.
const transcoder = spawn(
  process.execPath,
  [path.resolve(import.meta.dirname, '../../transcoder/src/main.ts')],
  {
    env: {
      ...process.env,
      CINEVAULT_ENV: path.join(dir, 'no.env'),
      TRANSCODER_TOKEN: token,
      TRANSCODER_PORT: String(transcoderPort),
      TRANSCODER_HWACCEL: 'none',
      TRANSCODER_READRATE: '1',
      TRANSCODER_READRATE_BURST: '8',
      MEDIA_ROOT: media,
      TRANSCODE_TMP: path.join(dir, 'transcode'),
    },
    stdio: 'inherit',
  },
);
process.on('exit', () => transcoder.kill());
const client = new TranscoderClient({ url: `http://127.0.0.1:${transcoderPort}`, token });
for (let attempt = 0; ; attempt++) {
  const ready = await client.health().then(
    (h) => h.ready,
    () => false,
  );
  if (ready) break;
  if (attempt > 100) throw new Error('transcoder did not start');
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const opensubtitles: SubtitleProvider = {
  name: 'opensubtitles',
  search: async () => [
    {
      id: '777',
      provider: 'opensubtitles',
      language: 'nld',
      release: 'Big.Buck.Test.2008.NL',
      downloads: 1234,
      hearingImpaired: false,
      matchesFile: true,
      machineTranslated: false,
    },
  ],
  download: async () => ({
    bytes: new TextEncoder().encode(
      '1\n00:00:00,500 --> 00:00:10,000\nGedownload van OpenSubtitles\n',
    ),
    fileName: 'Big.Buck.Test.2008.NL.srt',
  }),
};
const subtitles = new SubtitleService({
  prisma,
  mediaRoot: media,
  cacheDir: path.join(dir, 'cache'),
  transcoder: client,
  opensubtitles,
  // Only when asked: nobody is idle here.
  ocr: { engine: new TesseractEngine(path.join(dir, 'cache')), idle: () => false },
});

await ensureDefaultLibraries(prisma, media);
await scanner.scan();

// Collecties: two of the films are a series at "TMDB", whose third film isn't here.
await prisma.mediaItem.updateMany({
  where: { title: { in: ['Big Buck Test', 'Remux Test'] } },
  data: { collectionTmdbId: 500, collectionName: 'Test Saga Collection' },
});
const sagaIds = Object.fromEntries(
  (
    await prisma.mediaItem.findMany({
      where: { collectionTmdbId: 500 },
      select: { title: true, tmdbId: true },
    })
  ).map((i) => [i.title, i.tmdbId ?? 0]),
);
await prisma.collection.upsert({
  where: { tmdbId: 500 },
  update: {},
  create: {
    tmdbId: 500,
    name: 'Test Saga Collection',
    overview: 'Twee testfilms en een derde die nog ontbreekt.',
    parts: [
      {
        tmdbId: sagaIds['Big Buck Test'],
        title: 'Big Buck Test',
        releaseDate: '2008-01-01',
        year: 2008,
      },
      { tmdbId: sagaIds['Remux Test'], title: 'Remux Test', releaseDate: '2010-01-01', year: 2010 },
      { tmdbId: 777, title: 'Test Saga III', releaseDate: '2012-01-01', year: 2012 },
    ],
  },
});

// Skip Intro: the routes and the search (driven by the players, not started in the background).
const intro = new IntroService({ prisma, transcoder: client, cacheDir: path.join(dir, 'cache') });

// Theme music from a fake Plex: Short Show (TMDB 11, TVDB 9011) has a theme, nothing else.
const themeMp3 = path.join(dir, 'theme.mp3');
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'libmp3lame', themeMp3]);
const plexAsked: string[] = [];
const themes = new ThemeService({
  prisma,
  cacheDir: path.join(dir, 'cache'),
  providers: [
    new PlexThemeProvider(prisma, {
      fetch: (async (url: string) => {
        plexAsked.push(url);
        return url.endsWith('/9011.mp3')
          ? new Response(readFileSync(themeMp3), { headers: { 'content-type': 'audio/mpeg' } })
          : new Response('Not Found', { status: 404 });
      }) as typeof fetch,
      tvdbId: async (tmdbId) => (tmdbId === 11 ? 9011 : undefined),
    }),
  ],
});

// Timeline previews from the real transcoder, made before the tests (the files are short).
const thumbnails = new ThumbnailService({
  prisma,
  cacheDir: path.join(dir, 'cache'),
  transcoder: client,
  minDurationMs: 10_000,
});
await thumbnails.runOnce();

// Notifications without quiet hours in the way of the tests (the settings test turns them off).
const notifications = new NotificationService({
  prisma,
  push: new WebPushSender(prisma, 'mailto:e2e@example.org'),
  timeZone: 'Europe/Amsterdam',
});
const notificationEvents = new NotificationEvents(prisma, notifications, 'Europe/Amsterdam');

// "Verzoeken": TMDB knows one film that is not here; Radarr and Sonarr answer
// what CineVault asks (and remember what was added).
const arrival = {
  kind: 'movie' as const,
  tmdbId: 329865,
  title: 'Arrival',
  year: 2016,
  releaseDate: '2016-11-10',
  overview: 'Taal en tijd.',
  posterRef: 'tmdb:w342/arrival.jpg',
  backdropRef: 'tmdb:w1280/arrival-b.jpg',
  rating: 7.6,
  anime: false,
};
// "Meer zoals dit" for Arrival.
const bladeRunner = {
  kind: 'movie' as const,
  tmdbId: 335984,
  title: 'Blade Runner 2049',
  year: 2017,
  releaseDate: '2017-10-04',
  overview: 'Dertig jaar later.',
  posterRef: 'tmdb:w342/br2049.jpg',
  anime: false,
};
// A show not here yet, to ask for some seasons or episodes of.
const severance = {
  kind: 'tv' as const,
  tmdbId: 95396,
  title: 'Severance',
  year: 2022,
  releaseDate: '2022-02-17',
  overview: 'Werk en leven, gescheiden.',
  posterRef: 'tmdb:w342/severance.jpg',
  rating: 8.4,
  anime: false,
};
const severanceSeason = (n: number) => ({
  seasonNumber: n,
  name: `Season ${n}`,
  episodes: [1, 2, 3].map((e) => ({
    seasonNumber: n,
    episodeNumber: e,
    title: `Episode ${e}`,
    airDate: `202${n + 1}-02-0${e}`,
  })),
});
const requestTmdb: RequestTmdb = {
  searchForRequest: async (kind, query) =>
    kind === 'movie' && /arrival/i.test(query) ? [arrival] : [],
  searchAll: async (query) => ({ results: /arrival/i.test(query) ? [arrival] : [], totalPages: 1 }),
  discoverList: async (kind) => ({
    results: kind === 'movie' ? [arrival] : [severance],
    totalPages: 1,
  }),
  requestCandidate: async (_kind, id) =>
    id === arrival.tmdbId ? arrival : id === severance.tmdbId ? severance : undefined,
  requestDetails: async (_kind, id) =>
    id === arrival.tmdbId
      ? {
          ...arrival,
          genres: ['Drama', 'Sciencefiction'],
          runtimeMinutes: 116,
          trailerKey: 'arrivalTrailer',
          cast: [{ name: 'Amy Adams', character: 'Louise Banks', order: 0 }],
          collection: { id: 900, name: 'Arrival Collection' },
        }
      : id === bladeRunner.tmdbId
        ? { ...bladeRunner, genres: ['Sciencefiction'], cast: [] }
        : id === severance.tmdbId
          ? {
              ...severance,
              genres: ['Drama'],
              seasons: 2,
              cast: [
                { name: 'Adam Scott', character: 'Mark Scout', order: 0 },
                { name: 'Britt Lower', character: 'Helly R.', order: 1 },
              ],
              seasonList: [1, 2].map((n) => ({
                seasonNumber: n,
                name: `Seizoen ${n}`,
                episodeCount: 3,
                airDate: `202${n + 1}-02-01`,
              })),
            }
          : undefined,
  recommendations: async (_kind, id) => (id === arrival.tmdbId ? [bladeRunner] : []),
  collection: async (id) =>
    id === 900
      ? {
          id: 900,
          name: 'Arrival Collection',
          parts: [
            {
              tmdbId: arrival.tmdbId,
              title: 'Arrival',
              releaseDate: arrival.releaseDate,
              year: 2016,
              posterRef: arrival.posterRef,
            },
            { tmdbId: 990001, title: 'Arrival II', releaseDate: '2099-05-01', year: 2099 },
          ],
        }
      : undefined,
  requestSeason: async (id, n) =>
    id === severance.tmdbId && n <= 2 ? severanceSeason(n) : undefined,
  tvdbId: async (id) => (id === severance.tmdbId ? 371980 : undefined),
};
let sonarrHas = false;
/** The episodes Sonarr follows (ids as in /episode below). */
const sonarrFollows = new Set<number>();
const arrFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/system/status')) return json({ version: '5.21.1' });
  if (url.endsWith('/rootfolder')) return json([{ path: 'D:\\Movies' }, { path: 'D:\\Series' }]);
  if (url.endsWith('/qualityprofile')) return json([{ id: 4, name: 'HD-1080p' }]);
  if (url.includes('/movie/lookup/tmdb')) return json({ title: 'Arrival', tmdbId: 329865 });
  if (url.endsWith('/movie') && init?.method === 'POST') return json({ id: 1 }, 201);
  // Removing: Radarr has Big Buck Test, and "deletes" it (nothing on disk changes).
  if (url.endsWith('/movie') && (init?.method ?? 'GET') === 'GET') {
    return json([
      { id: 9, title: 'Big Buck Test', tmdbId: 1, path: 'D:\\Movies\\Big Buck Test (2008)' },
    ]);
  }
  // Sonarr: Severance, added without following anything, then only what was asked.
  if (url.includes('/series/lookup')) {
    return json([
      {
        title: 'Severance',
        tvdbId: 371980,
        ...(sonarrHas && { id: 5 }),
        seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
      },
    ]);
  }
  if (url.endsWith('/series') && init?.method === 'POST') {
    sonarrHas = true;
    return json({ ...JSON.parse(String(init.body)), id: 5 }, 201);
  }
  if (url.endsWith('/series/5') && init?.method === 'PUT') {
    // A season that is followed now: all its episodes too.
    for (const season of JSON.parse(String(init.body)).seasons as {
      seasonNumber: number;
      monitored?: boolean;
    }[]) {
      if (!season.monitored) continue;
      for (const e of severanceSeason(season.seasonNumber).episodes) {
        sonarrFollows.add(season.seasonNumber * 100 + e.episodeNumber);
      }
    }
    return json(JSON.parse(String(init.body)), 202);
  }
  if (url.endsWith('/series/5')) {
    return json({ id: 5, title: 'Severance', seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] });
  }
  if (url.includes('/episode?seriesId=5')) {
    return json(
      [1, 2].flatMap((n) =>
        severanceSeason(n).episodes.map((e) => {
          const id = n * 100 + e.episodeNumber;
          return { ...e, id, monitored: sonarrFollows.has(id) };
        }),
      ),
    );
  }
  if (url.endsWith('/episode/monitor')) {
    const body = JSON.parse(String(init?.body)) as { episodeIds: number[]; monitored: boolean };
    for (const id of body.episodeIds) {
      if (body.monitored) sonarrFollows.add(id);
      else sonarrFollows.delete(id);
    }
    return json({}, 202);
  }
  if (url.endsWith('/command')) return json({}, 202);
  if (url.includes('/movie/9?deleteFiles=true') && init?.method === 'DELETE') {
    return new Response('', { status: 200 });
  }
  return json({ message: 'not found' }, 404);
}) as typeof fetch;
const radarr = new RadarrClient({ url: 'http://radarr.test', apiKey: 'key', fetch: arrFetch });
const sonarr = new SonarrClient({ url: 'http://sonarr.test', apiKey: 'key', fetch: arrFetch });
const requests = new RequestService({ prisma, tmdb: requestTmdb, radarr, sonarr, notifications });
const remove = new RemoveService({ prisma, radarr, sonarr });

const app = await buildApp({
  checkDatabase: async () => {},
  services: {
    requests,
    remove,
    notifications,
    notificationEvents,
    prisma,
    scanner,
    metadata,
    images,
    mediaRoot: media,
    transcoder: client,
    subtitles,
    intro,
    themes,
    thumbnails,
    health: new HealthService({
      prisma,
      mediaRoot: media,
      cacheDir: path.join(dir, 'cache'),
      transcoder: client,
      scan: () => scanner.getStatus(),
      scanIntervalMinutes: 60,
      notifications,
    }),
  },
  auth: { jwtSecret: 'e2e-jwt-secret-0123456789abcdef-0123456789', apiToken },
});
await app.listen({ host: '127.0.0.1', port });
console.log(`e2e API on http://127.0.0.1:${port} (media in ${media})`);
