// Theme music for the detail pages (CLAUDE.md, "Themamuziek"). The
// ThemeService asks its providers in order; the first with a theme wins. First
// (besluit eigenaar, 2026-10-20) Plex's theme music for shows:
// tvthemes.plexapp.com/<TVDB id>.mp3, the service Plex servers use. It needs
// no Plex server, but it is not an official API and has no films. Then, for
// anime Plex has nothing for, the openings of AnimeThemes (animethemes.ts),
// and last ThemerrDB's YouTube links for any show (themerr.ts).
//
// Themes are kept in CACHE_DIR/themes, one MP3 per title, named after where it
// came from, so playing never depends on Plex being reachable.

import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ThemeInfo, ThemeSourceName, ThemeStatus } from '@cinevault/shared';
import type { PrismaClient } from '../generated/prisma/client.js';

/** What a theme is made from. */
export interface ThemeSource {
  provider: ThemeSourceName;
  /** Changes when the theme would sound different: the name of the cached file. */
  version: string;
}

export interface ThemeProvider<S extends ThemeSource = ThemeSource> {
  readonly name: ThemeSourceName;
  /** The sources for a title, best first (the next is tried when one fails). */
  sources(itemId: string): Promise<S[]>;
  audio(source: S): Promise<Buffer>;
}

/** A source that failed is left alone this long. */
const RETRY_MS = 6 * 60 * 60 * 1000;

/** The source has nothing for this title: asked again after `retryMs`, quietly. */
export class NoThemeError extends Error {
  constructor(
    message: string,
    readonly retryMs = RETRY_MS,
    /** Short, for Beheer: what the source answered. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** The source can't be reached now (down, slow): all titles wait a while. */
export class ThemeUnavailableError extends Error {}

/**
 * Plex's own agents (and other media servers' theme plugins) ask over plain
 * HTTP; HTTPS is tried first, and HTTP when HTTPS can't connect. Whichever
 * answered is used from then on.
 */
export const PLEX_THEMES_URLS = ['https://tvthemes.plexapp.com', 'http://tvthemes.plexapp.com'];
/** A show Plex has no theme for: it rarely gets one, so ask again after a week. */
const PLEX_MISSING_MS = 7 * 24 * 60 * 60 * 1000;
const PLEX_TIMEOUT_MS = 20_000;
const TVDB_LOOKUP_RETRY_MS = 24 * 60 * 60 * 1000;
/** Smaller is an error page, larger is no theme song. */
const MIN_BYTES = 10_000;
const MAX_BYTES = 15_000_000;

interface PlexSource extends ThemeSource {
  tvdbId: number;
}

export interface PlexThemeOptions {
  /** tvthemes.plexapp.com (PLEX_THEMES_URLS); tests use a fake. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** A show matched without a TVDB id: look it up from its TMDB id (and keep it). */
  tvdbId?: (tmdbId: number) => Promise<number | undefined>;
}

/** Plex's theme music for shows (and anime), by TVDB id. Films have none. */
export class PlexThemeProvider implements ThemeProvider<PlexSource> {
  readonly name = 'plex' as const;
  private readonly prisma: PrismaClient;
  private readonly options: PlexThemeOptions;
  /** Shows TMDB had no TVDB id for, and when to ask again (the lookup runs on every pass). */
  private readonly noTvdb = new Map<string, number>();
  /** The address that answered last: asked first. */
  private working: string | undefined;

  constructor(prisma: PrismaClient, options: PlexThemeOptions = {}) {
    this.prisma = prisma;
    this.options = options;
  }

  async sources(itemId: string): Promise<PlexSource[]> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: { type: true, tvdbId: true, tmdbId: true },
    });
    if (item?.type !== 'SHOW') return [];
    let tvdbId = item.tvdbId ?? undefined;
    if (!tvdbId && item.tmdbId && this.options.tvdbId) {
      if (Date.now() < (this.noTvdb.get(itemId) ?? 0)) return [];
      tvdbId = await this.options.tvdbId(item.tmdbId).catch(() => undefined);
      if (tvdbId) await this.prisma.mediaItem.update({ where: { id: itemId }, data: { tvdbId } });
      else this.noTvdb.set(itemId, Date.now() + TVDB_LOOKUP_RETRY_MS);
    }
    return tvdbId ? [{ provider: this.name, version: `tvdb-${tvdbId}`, tvdbId }] : [];
  }

  async audio(source: PlexSource): Promise<Buffer> {
    const bases = this.options.baseUrl
      ? [this.options.baseUrl]
      : [...new Set([this.working, ...PLEX_THEMES_URLS].filter((b): b is string => Boolean(b)))];
    let response: Response | undefined;
    let failure: unknown;
    // What each address that had nothing answered ("404 https"), for Beheer.
    const missing: string[] = [];
    for (const base of bases) {
      try {
        const answer = await (this.options.fetch ?? fetch)(
          `${base.replace(/\/+$/, '')}/${source.tvdbId}.mp3`,
          {
            headers: { 'user-agent': 'CineVault (theme music)' },
            signal: AbortSignal.timeout(PLEX_TIMEOUT_MS),
          },
        );
        // Plex answers 404 (or 403) for a show it has no theme for. The other
        // address may still have it (HTTPS and HTTP are served apart): ask that too.
        if (answer.status === 404 || answer.status === 403) {
          missing.push(`${answer.status} ${new URL(base).protocol.replace(':', '')}`);
          await answer.body?.cancel().catch(() => undefined);
          continue;
        }
        response = answer;
        this.working = base;
        break;
      } catch (error) {
        // No connection here (TLS, DNS, a timeout): the next address.
        failure = error;
      }
    }
    if (!response && missing.length > 0) {
      throw new NoThemeError(
        `Plex has no theme for TVDB ${source.tvdbId} (${missing.join(', ')})`,
        PLEX_MISSING_MS,
        missing.join(', '),
      );
    }
    if (!response) throw new ThemeUnavailableError(`Plex themes not reachable: ${String(failure)}`);
    if (response.status >= 500 || response.status === 429) {
      throw new ThemeUnavailableError(`Plex themes answered ${response.status}`);
    }
    if (!response.ok) throw new Error(`Plex themes answered ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    // An MP3 by its first bytes (an ID3 tag, or a frame), whatever the content-type says.
    if (audio.length < MIN_BYTES || !isMp3(audio)) {
      throw new NoThemeError(
        `Plex gave no MP3 for TVDB ${source.tvdbId} (${response.headers.get('content-type')}, ${audio.length} bytes)`,
        PLEX_MISSING_MS,
        `geen MP3 (${audio.length} bytes)`,
      );
    }
    if (audio.length > MAX_BYTES) throw new Error(`Plex theme too large: ${audio.length} bytes`);
    return audio;
  }
}

/** ID3v2 at the start, or an MPEG audio frame sync (11 bits set). */
export function isMp3(data: Buffer): boolean {
  if (data.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return data.length > 1 && data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0;
}

export interface ThemeServiceOptions {
  prisma: PrismaClient;
  /** CACHE_DIR: the themes are kept in CACHE_DIR/themes. */
  cacheDir: string;
  providers: ThemeProvider[];
  now?: () => number;
  log?: { warn: (obj: object, msg?: string) => void };
}

/** For Beheer: whose answer it is. */
const SOURCE_LABEL: Record<ThemeSourceName, string> = {
  plex: 'Plex',
  animethemes: 'AnimeThemes',
  themerrdb: 'ThemerrDB',
};

/** The source unreachable: try again after this long. */
const PAUSE_MS = 15 * 60 * 1000;
/**
 * A title whose source is "down" this many times in a row (one file that keeps
 * answering 503, say) counts as failed for that title, so it doesn't keep the
 * source paused for every other title.
 */
const MAX_STRIKES = 3;
/** How long GET /items/:id/theme waits for a theme being fetched. */
const WAIT_MS = 6000;
/** Titles prepared per background pass, a second apart (gentle on Plex). */
const BATCH = 50;
const SPACING_MS = 1000;

export class ThemeService {
  private readonly options: ThemeServiceOptions;
  private readonly dir: string;
  private readonly making = new Map<string, Promise<ThemeInfo>>();
  /**
   * Sources that failed (provider:version), until when they are left alone,
   * whether the source had none, and what it answered (for Beheer).
   */
  private readonly failed = new Map<string, { until: number; none: boolean; reason: string }>();
  /** Titles all of whose sources failed: why, for Beheer, until one is asked again. */
  private readonly outcomes = new Map<string, { until: number; none: boolean; reason: string }>();
  /** The last thing that went wrong, for Beheer. */
  private lastError: { message: string; at: number } | undefined;
  /** A source that can't be reached is left alone a while (the others go on). */
  private readonly pausedUntil = new Map<ThemeSourceName, number>();
  /** Per source of a title: how often in a row it was "down" (see MAX_STRIKES). */
  private readonly strikes = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private passing = false;

  constructor(options: ThemeServiceOptions) {
    this.options = options;
    this.dir = path.join(options.cacheDir, 'themes');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private file(itemId: string, source: ThemeSource): string {
    return path.join(this.dir, `${itemId}-${source.provider}-${source.version}.mp3`);
  }

  private info(itemId: string, source: ThemeSource | undefined, ready: boolean): ThemeInfo {
    return {
      url: source && ready ? `/api/items/${itemId}/theme.mp3?v=${source.version}` : null,
      pending: Boolean(source) && !ready,
      off: false,
      ...(source && { from: { source: source.provider } }),
    };
  }

  /** The sources of a title over all providers, best first. */
  private async sources(
    itemId: string,
  ): Promise<{ provider: ThemeProvider; source: ThemeSource }[]> {
    const all: { provider: ThemeProvider; source: ThemeSource }[] = [];
    for (const provider of this.options.providers) {
      for (const source of await provider.sources(itemId)) all.push({ provider, source });
    }
    return all;
  }

  private recentlyFailed(source: ThemeSource): boolean {
    const failed = this.failed.get(`${source.provider}:${source.version}`);
    return failed !== undefined && this.now() < failed.until;
  }

  /** The cached theme of a title, if there is one for its current source. */
  async cached(itemId: string): Promise<string | undefined> {
    return (await this.existing(itemId))?.file;
  }

  /**
   * The best source that has its file in the cache. A later source's file
   * counts even when an earlier one hasn't been asked (again) yet: after a
   * restart, or a week after Plex had none.
   */
  private async existing(
    itemId: string,
  ): Promise<{ source: ThemeSource; file: string } | undefined> {
    for (const { source } of await this.sources(itemId)) {
      const file = this.file(itemId, source);
      if (await exists(file)) return { source, file };
    }
    return undefined;
  }

  private paused(provider: ThemeSourceName): boolean {
    return this.now() < (this.pausedUntil.get(provider) ?? 0);
  }

  /**
   * A theme only if it is there already, without fetching one: for browsing
   * (the TV plays the theme of the poster with the focus), so that moving
   * along a row doesn't send a request for every title.
   */
  async ready(itemId: string): Promise<ThemeInfo> {
    const item = await this.options.prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: { themeOff: true },
    });
    if (!item) return { url: null, pending: false, off: false };
    if (item.themeOff) return { url: null, pending: false, off: true };
    const found = await this.existing(itemId);
    return found
      ? this.info(itemId, found.source, true)
      : { url: null, pending: false, off: false };
  }

  /**
   * What the detail page plays. Fetches the theme when it isn't there yet, and
   * waits a few seconds for it; `pending` when it takes longer.
   */
  async theme(itemId: string, options: { wait?: boolean } = {}): Promise<ThemeInfo> {
    const item = await this.options.prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: { themeOff: true },
    });
    if (!item) return { url: null, pending: false, off: false };
    if (item.themeOff) return { url: null, pending: false, off: true };
    const making = this.making.get(itemId) ?? this.make(itemId);
    if (options.wait === false) return making;
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), WAIT_MS);
    });
    const result = await Promise.race([making, waited]);
    clearTimeout(timer);
    if (result) return result;
    const sources = await this.sources(itemId);
    const next = sources.find(({ source }) => !this.recentlyFailed(source));
    return this.info(itemId, next?.source, false);
  }

  private make(itemId: string): Promise<ThemeInfo> {
    const job = this.run(itemId).finally(() => this.making.delete(itemId));
    this.making.set(itemId, job);
    return job;
  }

  private async run(itemId: string): Promise<ThemeInfo> {
    const sources = await this.sources(itemId);
    // What every source answered, for Beheer when none has a theme.
    const answers: { until: number; none: boolean; reason: string }[] = [];
    for (const { provider, source } of sources) {
      const file = this.file(itemId, source);
      if (await exists(file)) {
        this.outcomes.delete(itemId);
        return this.info(itemId, source, true);
      }
      const known = this.failed.get(`${source.provider}:${source.version}`);
      if (known && this.now() < known.until) {
        answers.push(known);
        continue;
      }
      // Can't be reached now: wait for it rather than take a later source.
      if (this.paused(source.provider)) return this.info(itemId, source, false);
      try {
        const audio = await provider.audio(source);
        await mkdir(this.dir, { recursive: true });
        await writeFile(`${file}.tmp`, audio);
        await rename(`${file}.tmp`, file);
        await this.forgetOthers(itemId, file);
        this.outcomes.delete(itemId);
        this.strikes.delete(`${source.provider}:${source.version}`);
        return this.info(itemId, source, true);
      } catch (error) {
        const key = `${source.provider}:${source.version}`;
        const strikes =
          error instanceof ThemeUnavailableError ? (this.strikes.get(key) ?? 0) + 1 : 0;
        if (error instanceof ThemeUnavailableError && strikes < MAX_STRIKES) {
          // The source, not this title: try again later.
          this.strikes.set(key, strikes);
          this.pausedUntil.set(source.provider, this.now() + PAUSE_MS);
          this.lastError = { message: error.message, at: this.now() };
          this.options.log?.warn({ err: error }, 'themes: the source cannot be reached now');
          return this.info(itemId, source, false);
        }
        this.strikes.delete(key);
        const none = error instanceof NoThemeError;
        const answer = {
          until: this.now() + (none ? error.retryMs : RETRY_MS),
          none,
          reason: `${SOURCE_LABEL[source.provider]}: ${(none && error.detail) || String((error as Error).message ?? error)}`,
        };
        this.failed.set(`${source.provider}:${source.version}`, answer);
        answers.push(answer);
        // Nothing to play there (a show Plex has no theme for): the next source, quietly.
        if (!none) {
          this.lastError = { message: String((error as Error).message ?? error), at: this.now() };
          this.options.log?.warn({ err: error, itemId }, 'themes: could not get one');
        }
      }
    }
    if (answers.length > 0) {
      this.outcomes.set(itemId, {
        until: Math.min(...answers.map((a) => a.until)),
        none: answers.every((a) => a.none),
        reason: answers.map((a) => a.reason).join(' · '),
      });
    }
    return { url: null, pending: false, off: false };
  }

  /** Other themes of this title (an earlier source). */
  private async forgetOthers(itemId: string, keep: string): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.startsWith(`${itemId}-`) && name.endsWith('.mp3') && file !== keep) {
        await unlink(file).catch(() => {});
      }
    }
  }

  /**
   * Themes from sources that are no longer used: the intros and end credits
   * cut from the own files before Plex was the source (and what the end
   * credits search kept).
   */
  async cleanUp(): Promise<void> {
    const providers = new Set(this.options.providers.map((p) => p.name));
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name === 'end-credits') {
        await rm(file, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      // <itemId (a UUID, 5 parts)>-<provider>-<version>.mp3
      const provider = name.split('-')[5];
      if (name.endsWith('.mp3') && (!provider || !providers.has(provider as ThemeSourceName))) {
        await unlink(file).catch(() => {});
      }
    }
  }

  /** How far fetching is, for Beheer. */
  async status(): Promise<ThemeStatus> {
    const shows = await this.options.prisma.mediaItem.count({
      where: { type: 'SHOW', themeOff: false },
    });
    const providers = this.options.providers.map((p) => p.name);
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const ready = new Set(
      names
        .filter((n) => n.endsWith('.mp3') && providers.some((p) => n.includes(`-${p}-`)))
        .map((n) => n.split('-').slice(0, 5).join('-')),
    ).size;
    const now = this.now();
    const haveFile = new Set(
      names.filter((n) => n.endsWith('.mp3')).map((n) => n.split('-').slice(0, 5).join('-')),
    );
    const outcomes = [...this.outcomes.entries()].filter(
      ([itemId, o]) => now < o.until && !haveFile.has(itemId),
    );
    const items = await this.options.prisma.mediaItem.findMany({
      where: { id: { in: outcomes.map(([itemId]) => itemId) }, themeOff: false },
      select: { id: true, title: true, year: true, tvdbId: true },
    });
    const missing = outcomes
      .flatMap(([itemId, o]) => {
        const item = items.find((i) => i.id === itemId);
        return item
          ? [
              {
                itemId: item.id,
                title: item.title,
                ...(item.year && { year: item.year }),
                ...(item.tvdbId && { tvdbId: item.tvdbId }),
                none: o.none,
                reason: o.reason,
              },
            ]
          : [];
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    const paused = [...this.pausedUntil.entries()]
      .filter(([, until]) => now < until)
      .sort((a, b) => b[1] - a[1]);
    return {
      enabled: providers.length > 0,
      sources: providers,
      shows,
      ready,
      none: missing.filter((m) => m.none).length,
      failed: missing.filter((m) => !m.none).length,
      ...(paused[0] && {
        pausedUntil: new Date(paused[0][1]).toISOString(),
        pausedSource: paused[0][0],
      }),
      ...(this.lastError && {
        lastError: {
          message: this.lastError.message,
          at: new Date(this.lastError.at).toISOString(),
        },
      }),
      ...(missing.length > 0 && { missing }),
    };
  }

  /**
   * Asks the sources again now for the shows they had nothing for, or that
   * failed (and after a pause): from Beheer, after a match was corrected, or
   * to check.
   */
  retry(): void {
    this.failed.clear();
    this.outcomes.clear();
    this.pausedUntil.clear();
    this.strikes.clear();
    this.lastError = undefined;
    this.prepare(BATCH * 4).catch((error: unknown) =>
      this.options.log?.warn({ err: error }, 'themes: trying again failed'),
    );
  }

  /** Turns a title's theme off or on. */
  async choose(itemId: string, choice: { off: boolean }): Promise<void> {
    await this.options.prisma.mediaItem.update({
      where: { id: itemId },
      data: { themeOff: choice.off },
    });
  }

  /**
   * Fetches the themes of titles that have none yet, newest first, a few at a
   * time, so that a detail page has its theme at once.
   */
  async prepare(limit = BATCH, spacingMs = SPACING_MS): Promise<number> {
    if (this.passing || this.allPaused()) return 0;
    this.passing = true;
    try {
      const titles = await this.options.prisma.mediaItem.findMany({
        where: { themeOff: false },
        select: { id: true },
        orderBy: { addedAt: { sort: 'desc', nulls: 'last' } },
      });
      let asked = 0;
      let made = 0;
      for (const title of titles) {
        if (asked >= limit || this.allPaused()) break;
        if (await this.cached(title.id)) continue;
        const sources = await this.sources(title.id);
        // Nothing to ask: no source, all had nothing, or the next one to ask can't be reached.
        const next = sources.find(({ source }) => !this.recentlyFailed(source));
        if (!next || this.paused(next.source.provider)) continue;
        if (asked > 0 && spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
        asked++;
        const info = await (this.making.get(title.id) ?? this.make(title.id));
        if (info.url) made++;
      }
      return made;
    } finally {
      this.passing = false;
    }
  }

  private allPaused(): boolean {
    const providers = this.options.providers;
    return providers.length > 0 && providers.every((p) => this.paused(p.name));
  }

  start(intervalMs = 10 * 60 * 1000): void {
    const tick = () => {
      this.prepare().catch((error: unknown) =>
        this.options.log?.warn({ err: error }, 'themes: preparing failed'),
      );
    };
    this.cleanUp().catch(() => {});
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    setTimeout(tick, 60_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
