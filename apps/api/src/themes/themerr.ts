// ThemerrDB (LizardByte): a community list of theme songs as YouTube links, by
// TMDB id. The third source of theme music (verzoek eigenaar, 2026-10-22: "Bouw
// ook ThemerrDB met YouTube voor de gewone series"), after Plex and
// AnimeThemes: for the shows neither of those has.
//
// The audio comes from YouTube, with yt-dlp (in the API image). YouTube changes
// often and then an old yt-dlp stops working, so the API keeps its own copy in
// CACHE_DIR/bin and updates it once a day (yt-dlp -U). It needs a JavaScript
// runtime for YouTube: the API's own Node. Downloading from YouTube is against
// YouTube's terms; the owner chose it knowing that.

import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '../generated/prisma/client.js';
import { toMp3 } from './audio.js';
import {
  isMp3,
  NoThemeError,
  type ThemeProvider,
  type ThemeSource,
  ThemeUnavailableError,
} from './service.js';

export const THEMERRDB_URL = 'https://app.lizardbyte.dev/ThemerrDB';
/** Not in ThemerrDB, or the video can't be had: asked again after a week. */
const MISSING_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;
/** A theme song, not an hour-long loop: the rest of a longer video is cut off. */
const MAX_SECONDS = 180;
const MAX_VIDEO_SECONDS = 900;

interface ThemerrSource extends ThemeSource {
  tmdbId: number;
}

/** Downloads the audio of a YouTube video into `dir`; returns the file. */
export interface YouTubeAudio {
  download(url: string, dir: string): Promise<string>;
}

export interface ThemerrDbOptions {
  youtube: YouTubeAudio;
  baseUrl?: string;
  fetch?: typeof fetch;
  ffmpeg?: string;
}

export class ThemerrDbProvider implements ThemeProvider<ThemerrSource> {
  readonly name = 'themerrdb' as const;
  private readonly prisma: PrismaClient;
  private readonly options: ThemerrDbOptions;

  constructor(prisma: PrismaClient, options: ThemerrDbOptions) {
    this.prisma = prisma;
    this.options = options;
  }

  async sources(itemId: string): Promise<ThemerrSource[]> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: { type: true, tmdbId: true },
    });
    if (item?.type !== 'SHOW' || !item.tmdbId) return [];
    return [{ provider: this.name, version: `tmdb-${item.tmdbId}`, tmdbId: item.tmdbId }];
  }

  async audio(source: ThemerrSource): Promise<Buffer> {
    const url = await this.youtubeUrl(source.tmdbId);
    const dir = await mkdtemp(path.join(tmpdir(), 'cinevault-theme-'));
    try {
      const file = await this.options.youtube.download(url, dir);
      const mp3 = await toMp3(file, { ffmpeg: this.options.ffmpeg, maxSeconds: MAX_SECONDS });
      if (!isMp3(mp3) || mp3.length < 10_000)
        throw new Error('FFmpeg made no MP3 of the YouTube audio');
      return mp3;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The YouTube link ThemerrDB has for a show (tv_shows/themoviedb/<id>.json). */
  private async youtubeUrl(tmdbId: number): Promise<string> {
    const base = (this.options.baseUrl ?? THEMERRDB_URL).replace(/\/+$/, '');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${base}/tv_shows/themoviedb/${tmdbId}.json`, {
        headers: { 'user-agent': 'CineVault (theme music)', accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ThemeUnavailableError(`ThemerrDB not reachable: ${String(error)}`);
    }
    if (response.status === 404) {
      throw new NoThemeError(
        `ThemerrDB has no theme for TMDB ${tmdbId}`,
        MISSING_MS,
        'niet in ThemerrDB',
      );
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ThemeUnavailableError(`ThemerrDB answered ${response.status}`);
    }
    if (!response.ok) throw new Error(`ThemerrDB answered ${response.status}`);
    const data = (await response.json().catch(() => undefined)) as
      { youtube_theme_url?: unknown } | undefined;
    const url = data?.youtube_theme_url;
    if (
      typeof url !== 'string' ||
      !/^https:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(url)
    ) {
      throw new NoThemeError(
        `ThemerrDB has no YouTube link for TMDB ${tmdbId}`,
        MISSING_MS,
        'geen YouTube-link',
      );
    }
    return url;
  }
}

/** What yt-dlp says when YouTube itself is the problem now (not this video). */
const YOUTUBE_DOWN =
  /sign in to confirm|not a bot|HTTP Error 429|too many requests|unable to connect|getaddrinfo|name resolution|timed out|network is unreachable|connection (reset|refused)/i;
/** What yt-dlp says when this video can't be had. */
const VIDEO_GONE =
  /video unavailable|private video|has been removed|no longer available|terminated|copyright|not available in your country|blocked it in your country|members-only|join this channel|age-restricted|confirm your age|inappropriate|premieres in|is live|larger than max-filesize/i;

export interface YtDlpOptions {
  /** YTDLP_PATH: this binary as it is, without updating it. */
  path?: string;
  /** Without `path`: the API's own copy goes in CACHE_DIR/bin, and is updated daily. */
  cacheDir?: string;
  /** Where the image put yt-dlp (copied to the cache the first time). */
  bundled?: string;
  /** The JavaScript runtime yt-dlp needs for YouTube: this Node. */
  node?: string;
  now?: () => number;
  log?: { warn: (obj: object, msg?: string) => void };
}

/** yt-dlp, one download at a time. */
export class YtDlp implements YouTubeAudio {
  private readonly options: YtDlpOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private updatedAt = -Infinity;

  constructor(options: YtDlpOptions = {}) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  download(url: string, dir: string): Promise<string> {
    const job = this.queue.then(() => this.fetchAudio(url, dir));
    this.queue = job.catch(() => {});
    return job;
  }

  private async fetchAudio(url: string, dir: string): Promise<string> {
    const bin = await this.binary();
    const result = await run(
      bin,
      [
        ...['--no-playlist', '--quiet', '--no-warnings', '--no-progress', '--no-part'],
        ...['--js-runtimes', `node:${this.options.node ?? process.execPath}`],
        ...(this.options.cacheDir
          ? ['--cache-dir', path.join(this.options.cacheDir, 'yt-dlp-cache')]
          : []),
        ...['-f', 'bestaudio/best', '--max-filesize', '60M'],
        ...['--match-filters', `!is_live & duration <=? ${MAX_VIDEO_SECONDS}`],
        ...['-o', path.join(dir, 'theme.%(ext)s'), '--print', 'after_move:filepath'],
        '--',
        url,
      ],
      180_000,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new ThemeUnavailableError(`yt-dlp not found (${bin})`);
      throw error;
    });
    const problem = lastError(result.stderr);
    if (result.code !== 0) {
      if (YOUTUBE_DOWN.test(result.stderr)) throw new ThemeUnavailableError(`YouTube: ${problem}`);
      if (VIDEO_GONE.test(result.stderr)) {
        throw new NoThemeError(`YouTube: ${problem}`, MISSING_MS, `YouTube: ${short(problem)}`);
      }
      // Most likely YouTube changed and this yt-dlp can't read it: update before the next one.
      this.updatedAt = -Infinity;
      throw new Error(`yt-dlp: ${problem || `exited with ${result.code}`}`);
    }
    const file = result.stdout.trim().split('\n').pop()?.trim();
    if (!file || !(await exists(file))) {
      // Skipped by the filter: live, or longer than a theme song.
      throw new NoThemeError(
        `YouTube video skipped: ${url}`,
        MISSING_MS,
        'YouTube: te lang of live',
      );
    }
    return file;
  }

  /** The binary to run: YTDLP_PATH, else the own copy (updated once a day). */
  private async binary(): Promise<string> {
    if (this.options.path) return this.options.path;
    const bundled = this.options.bundled ?? 'yt-dlp';
    if (!this.options.cacheDir) return bundled;
    const own = path.join(this.options.cacheDir, 'bin', 'yt-dlp');
    if (!(await exists(own))) {
      try {
        await mkdir(path.dirname(own), { recursive: true });
        await copyFile(bundled, own);
        await chmod(own, 0o755);
      } catch (error) {
        this.options.log?.warn({ err: error }, 'themes: could not copy yt-dlp to the cache');
        return bundled;
      }
    }
    if (this.now() - this.updatedAt > 24 * 60 * 60 * 1000) {
      this.updatedAt = this.now();
      const update = await run(own, ['-U'], 120_000).catch((error: unknown) => ({
        code: 1,
        stdout: '',
        stderr: String(error),
      }));
      if (update.code !== 0) {
        this.options.log?.warn({ stderr: update.stderr.slice(-300) }, 'themes: yt-dlp -U failed');
      }
    }
    return own;
  }
}

function lastError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const error = [...lines].reverse().find((l) => l.startsWith('ERROR:')) ?? lines.at(-1) ?? '';
  return error.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, '').slice(0, 300);
}

function short(problem: string): string {
  return problem.length > 80 ? `${problem.slice(0, 77)}…` : problem;
}

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-10_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-10_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr: signal ? `${stderr}\nERROR: timed out` : stderr });
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
