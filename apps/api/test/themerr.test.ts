// Theme music from ThemerrDB's YouTube links: a fake ThemerrDB, a fake yt-dlp
// (a script that answers like the real one), and a real FFmpeg.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/db.js';
import { isMp3, NoThemeError, ThemeUnavailableError } from '../src/themes/service.js';
import { ThemerrDbProvider, YtDlp } from '../src/themes/themerr.js';

// The fake yt-dlp: logs its arguments, and answers by what is in the URL.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '-U') process.exit(0);
const url = args.at(-1);
const fail = (line) => { process.stderr.write('ERROR: [youtube] abc123: ' + line + '\\n'); process.exit(1); };
if (url.includes('private')) fail('Private video. Sign in if you have been granted access to this video');
if (url.includes('bot')) fail('Sign in to confirm you are not a bot. Use --cookies-from-browser');
if (url.includes('broken')) fail('Unable to extract nsig function code');
if (url.includes('long')) process.exit(0);
const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'sine=frequency=330:duration=200', '-c:a', 'libopus', '-b:a', '32k', out]);
console.log(out);
`;

describe('theme music from ThemerrDB and YouTube', () => {
  let dir: string;
  let log: string;
  let bundled: string;
  let now = 1_000_000;

  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-themerr-'));
    log = path.join(dir, 'calls.log');
    writeFileSync(log, '');
    bundled = path.join(dir, 'yt-dlp-bundled');
    writeFileSync(bundled, FAKE, { mode: 0o755 });
    process.env.FAKE_LOG = log;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const ytDlp = () =>
    new YtDlp({ cacheDir: path.join(dir, 'cache'), bundled, node: '/opt/node', now: () => now });

  const shows: Record<string, { type: 'SHOW' | 'MOVIE'; tmdbId: number | null }> = {
    office: { type: 'SHOW', tmdbId: 2316 },
    unknown: { type: 'SHOW', tmdbId: 9999 },
    noTmdb: { type: 'SHOW', tmdbId: null },
    film: { type: 'MOVIE', tmdbId: 603 },
  };
  const prisma = {
    mediaItem: { findUnique: async ({ where }: { where: { id: string } }) => shows[where.id] },
  } as unknown as PrismaClient;
  const themerrAsked: string[] = [];
  const provider = (youtube = ytDlp()) =>
    new ThemerrDbProvider(prisma, {
      youtube,
      baseUrl: 'https://themerr.test/ThemerrDB/',
      fetch: (async (url: string) => {
        themerrAsked.push(url);
        if (url.endsWith('/tv_shows/themoviedb/2316.json')) {
          return Response.json({ youtube_theme_url: 'https://www.youtube.com/watch?v=office0000' });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch,
    });

  it('has a source for shows with a TMDB id only', async () => {
    const p = provider();
    expect(await p.sources('office')).toEqual([
      { provider: 'themerrdb', version: 'tmdb-2316', tmdbId: 2316 },
    ]);
    expect(await p.sources('noTmdb')).toEqual([]);
    expect(await p.sources('film')).toEqual([]);
  });

  it("downloads the show's YouTube theme and keeps three minutes of it as MP3", async () => {
    const p = provider();
    const [source] = await p.sources('office');
    if (!source) throw new Error('no source');
    const mp3 = await p.audio(source);
    expect(isMp3(mp3)).toBe(true);
    expect(themerrAsked).toContain('https://themerr.test/ThemerrDB/tv_shows/themoviedb/2316.json');
    const file = path.join(dir, 'out.mp3');
    writeFileSync(file, mp3);
    // Decoded (an MP3 through a pipe has no header with its length): 8000 samples of 2 bytes a second.
    const pcm = execFileSync(
      'ffmpeg',
      [
        ...['-hide_banner', '-loglevel', 'error', '-i', file],
        ...['-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'],
      ],
      { maxBuffer: 20_000_000 },
    );
    const seconds = pcm.length / 16_000;
    expect(seconds).toBeGreaterThan(170);
    expect(seconds).toBeLessThan(185);
    // Its own copy in the cache, updated first, with this Node as the JavaScript runtime.
    const [update, download] = calls();
    expect(update).toEqual(['-U']);
    expect(download).toEqual(
      expect.arrayContaining(['--js-runtimes', 'node:/opt/node', '--no-playlist']),
    );
    expect(download?.at(-1)).toBe('https://www.youtube.com/watch?v=office0000');
  }, 30_000); // FFmpeg makes a 3-minute MP3 and decodes it again: slow on a busy machine.

  it('has nothing for a show not in ThemerrDB', async () => {
    const p = provider();
    const error = await p
      .audio({ provider: 'themerrdb', version: 'tmdb-9999', tmdbId: 9999 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(NoThemeError);
    expect((error as NoThemeError).detail).toBe('niet in ThemerrDB');
  });

  it('tells a gone video from YouTube being in the way, and updates yt-dlp after an unknown error', async () => {
    const y = ytDlp();
    const gone = await y.download('https://www.youtube.com/watch?v=private0', dir).catch((e) => e);
    expect(gone).toBeInstanceOf(NoThemeError);
    expect((gone as NoThemeError).detail).toMatch(/^YouTube: Private video/);

    const bot = await y.download('https://www.youtube.com/watch?v=bot00000', dir).catch((e) => e);
    expect(bot).toBeInstanceOf(ThemeUnavailableError);

    const long = await y.download('https://www.youtube.com/watch?v=long0000', dir).catch((e) => e);
    expect((long as NoThemeError).detail).toBe('YouTube: te lang of live');

    writeFileSync(log, '');
    const broken = await y
      .download('https://www.youtube.com/watch?v=broken00', dir)
      .catch((e) => e);
    expect(broken).toBeInstanceOf(Error);
    expect(String(broken)).toContain('nsig');
    expect(calls().filter((c) => c[0] === '-U')).toHaveLength(0);
    // The next download updates yt-dlp first (YouTube may have changed).
    await y.download('https://www.youtube.com/watch?v=office0000', dir);
    expect(calls().filter((c) => c[0] === '-U')).toHaveLength(1);
    // Otherwise once a day.
    await y.download('https://www.youtube.com/watch?v=office0000', dir);
    expect(calls().filter((c) => c[0] === '-U')).toHaveLength(1);
    now += 25 * 60 * 60 * 1000;
    await y.download('https://www.youtube.com/watch?v=office0000', dir);
    expect(calls().filter((c) => c[0] === '-U')).toHaveLength(2);
  });

  it('waits for YouTube when yt-dlp is missing', async () => {
    const y = new YtDlp({ path: path.join(dir, 'no-such-yt-dlp') });
    const error = await y
      .download('https://www.youtube.com/watch?v=office0000', dir)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ThemeUnavailableError);
  });
});
