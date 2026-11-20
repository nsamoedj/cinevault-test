// Recognises movies and episodes from paths inside a library folder.
// Naming follows what Radarr/Sonarr (and Plex) produce, e.g.
//   A Legend (2024)/A Legend (2024) Bluray-2160p.mkv
//   Bleach/Season 17/Bleach - S17E01 - THE BLOOD WARFARE WEBDL-2160p.mkv
// Pure functions: no file system access.

export type LibraryKind = 'MOVIES' | 'SHOWS' | 'ANIME';

export interface IdHints {
  tmdb?: number;
  imdb?: string;
  tvdb?: number;
}

export interface ParsedMovie {
  kind: 'movie';
  /** Path of the item inside the library: the movie folder, or the file itself. */
  itemPath: string;
  title: string;
  year?: number;
  ids: IdHints;
}

export interface ParsedEpisode {
  kind: 'episode';
  /** Path of the show inside the library (its folder). */
  itemPath: string;
  showTitle: string;
  showYear?: number;
  ids: IdHints;
  /** Undefined when only an absolute number is known (anime). */
  season?: number;
  /** One entry, or several for multi-episode files (S01E01-E02). */
  episodes: number[];
  absolute?: number;
  episodeTitle?: string;
}

export interface Skipped {
  kind: 'skip';
  reason: string;
}

export type ParsedFile = ParsedMovie | ParsedEpisode | Skipped;

export const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.m4v',
  '.avi',
  '.mov',
  '.ts',
  '.m2ts',
  '.webm',
  '.wmv',
  '.mpg',
  '.mpeg',
]);

// Plex extras folders and file suffixes; these are not the main feature.
const EXTRA_FOLDERS = new Set([
  'behind the scenes',
  'deleted scenes',
  'extras',
  'featurettes',
  'interviews',
  'other',
  'sample',
  'samples',
  'scenes',
  'shorts',
  'trailers',
]);
// Plex style "Movie (2010)-trailer"; a space before the dash means it's part of a title.
const EXTRA_SUFFIX =
  /(?<=\S)-(trailer|sample|featurette|behindthescenes|deleted|interview|scene|short|other)$/i;

const SEASON_FOLDER = /^(?:season|series|staffel|seizoen|saison)[ ._-]*(\d{1,4})$|^s(\d{1,4})$/i;
const SPECIALS_FOLDER = /^specials?$/i;

// Trailing quality as written by Sonarr/Radarr ("WEBDL-2160p", "Bluray-1080p Remux").
const QUALITY_SUFFIX =
  /\s+(?:(?:bluray|web-?dl|webrip|hdtv|dvd|sdtv|raw-hd|br-disk|remux)(?:-\d{3,4}p)?|\d{3,4}p)(?:\s+(?:remux|proper|repack))*$/i;
// Only square brackets: "(US)" in "The Office (US)" is part of the title.
const TRAILING_BRACKETS = /\s*\[[^\]]*\]\s*$/;
// Round brackets only when they hold a resolution: "(1080p)", "(BD 1080p HEVC)".
const TRAILING_RESOLUTION = /\s*\([^)]*\b\d{3,4}p\b[^)]*\)\s*$/i;
const LEADING_BRACKETS = /^\s*\[[^\]]*\]\s*/;

const ID_HINT = /\{(tmdb|imdb|tvdb)-([^}]+)\}|\[(tmdbid|imdbid|tvdbid)[-=]([^\]]+)\]/gi;

export function isVideoFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && VIDEO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** Reads {tmdb-123} / {imdb-tt123} / {tvdb-123} and Jellyfin-style [tmdbid-123]. */
export function extractIdHints(text: string): { ids: IdHints; rest: string } {
  const ids: IdHints = {};
  const rest = text.replace(ID_HINT, (_match, a?: string, b?: string, c?: string, d?: string) => {
    const kind = (a ?? c ?? '').toLowerCase().replace(/id$/, '');
    const value = (b ?? d ?? '').trim();
    if (kind === 'imdb' && /^tt\d+$/.test(value)) ids.imdb = value;
    if ((kind === 'tmdb' || kind === 'tvdb') && /^\d+$/.test(value)) ids[kind] = Number(value);
    return ' ';
  });
  return { ids, rest: rest.replace(/\s{2,}/g, ' ').trim() };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Scene-style names use dots/underscores instead of spaces. */
function normaliseSpacing(text: string): string {
  const spaced = text.includes(' ') ? text : text.replace(/[._]+/g, ' ');
  return spaced.replace(/\s{2,}/g, ' ').trim();
}

function stripQuality(text: string): string {
  let result = text;
  for (;;) {
    const next = result
      .replace(QUALITY_SUFFIX, '')
      .replace(TRAILING_BRACKETS, '')
      .replace(TRAILING_RESOLUTION, '');
    if (next === result) return result.trim();
    result = next;
  }
}

function cleanTitle(text: string): string {
  return stripQuality(normaliseSpacing(text.replace(LEADING_BRACKETS, '')))
    .replace(/[\s-]+$/, '')
    .trim();
}

/** "Title (2024) anything" → title + year; the last "(yyyy)" wins ("Blade Runner 2049 (2017)"). */
function splitTitleYear(text: string): { title: string; year?: number } {
  const parens = /^(.*)\((\d{4})\)/.exec(text);
  if (parens?.[1]?.trim()) {
    return { title: cleanTitle(parens[1]), year: Number(parens[2]) };
  }
  // Scene style: "Blade.Runner.2049.2017.1080p" → last plausible year after the title.
  const spaced = normaliseSpacing(text);
  const years = [...spaced.matchAll(/[ ([]((?:19|20)\d{2})(?=[ )\]]|$)/g)];
  const last = years.at(-1);
  if (last && (last.index ?? 0) > 0) {
    return { title: cleanTitle(spaced.slice(0, last.index ?? 0)), year: Number(last[1]) };
  }
  return { title: cleanTitle(text) };
}

function isExtra(segments: string[], baseName: string): boolean {
  if (segments.slice(0, -1).some((s) => EXTRA_FOLDERS.has(s.toLowerCase()))) return true;
  return EXTRA_SUFFIX.test(baseName) || /^sample$/i.test(baseName);
}

function isHidden(segment: string): boolean {
  return /^[.@#$]/.test(segment) || segment.toLowerCase() === 'system volume information';
}

export function parseMovie(relPath: string): ParsedMovie | Skipped {
  const segments = relPath.split('/');
  const fileName = segments.at(-1) ?? '';
  const baseName = stripExtension(fileName);
  const folder = segments.length > 1 ? segments[0] : undefined;

  const folderInfo = folder ? extractIdHints(folder) : { ids: {}, rest: '' };
  const fileInfo = extractIdHints(baseName);
  const ids = { ...fileInfo.ids, ...folderInfo.ids };

  // Radarr puts "Title (Year)" on the folder; fall back to the file name.
  let parsed = folder ? splitTitleYear(folderInfo.rest) : { title: '' };
  if (!parsed.year) {
    const fromFile = splitTitleYear(fileInfo.rest);
    if (fromFile.year || !parsed.title) parsed = fromFile;
  }
  if (!parsed.title) return { kind: 'skip', reason: 'no title' };

  return {
    kind: 'movie',
    itemPath: folder ?? relPath,
    title: parsed.title,
    ...(parsed.year && { year: parsed.year }),
    ids,
  };
}

interface EpisodeMatch {
  season?: number;
  episodes: number[];
  absolute?: number;
  before: string;
  after: string;
}

function matchEpisode(baseName: string): EpisodeMatch | undefined {
  // S01E01, S01E01E02, S01E01-E02, S01E01-03
  const se = /(?:^|[ ._\-[(])S(\d{1,4})[ ._-]?E(\d{1,4})/i.exec(baseName);
  if (se) {
    const episodes = [Number(se[2])];
    let after = baseName.slice(se.index + se[0].length);
    for (;;) {
      const more = /^(?:[-_]?E(\d{1,4})|-(\d{1,4})(?=\D|$))/i.exec(after);
      if (!more) break;
      const last = episodes.at(-1) ?? 0;
      if (more[1]) {
        episodes.push(Number(more[1]));
      } else {
        for (let n = last + 1; n <= Number(more[2]); n++) episodes.push(n);
      }
      after = after.slice(more[0].length);
    }
    return {
      season: Number(se[1]),
      episodes,
      before: baseName.slice(0, se.index),
      after,
    };
  }

  // 1x01
  const x = /(?:^|[ ._\-[(])(\d{1,2})x(\d{2,3})(?=\D|$)/i.exec(baseName);
  if (x) {
    return {
      season: Number(x[1]),
      episodes: [Number(x[2])],
      before: baseName.slice(0, x.index),
      after: baseName.slice(x.index + x[0].length),
    };
  }

  // Anime absolute numbering: "[Group] Title - 01 [1080p]", "Title - 1071v2"
  const abs = /\s-\s(\d{1,4})(?:v\d)?(?=\s|$|[[(])/.exec(baseName);
  if (abs) {
    const absolute = Number(abs[1]);
    return {
      episodes: [absolute],
      absolute,
      before: baseName.slice(0, abs.index),
      after: baseName.slice(abs.index + abs[0].length),
    };
  }
  return undefined;
}

export function parseEpisode(relPath: string): ParsedEpisode | Skipped {
  const segments = relPath.split('/');
  const fileName = segments.at(-1) ?? '';
  const baseName = stripExtension(fileName);
  const match = matchEpisode(baseName);
  if (!match) return { kind: 'skip', reason: 'no episode number' };

  let season = match.season;
  if (season === undefined) {
    for (const segment of segments.slice(1, -1)) {
      if (SPECIALS_FOLDER.test(segment)) season = 0;
      const folder = SEASON_FOLDER.exec(segment);
      if (folder) season = Number(folder[1] ?? folder[2]);
    }
  }

  const showFolder = segments.length > 1 ? segments[0] : undefined;
  const source = extractIdHints(showFolder ?? match.before);
  const fileHints = extractIdHints(baseName).ids;
  const show = splitTitleYear(source.rest);
  if (!show.title) return { kind: 'skip', reason: 'no show title' };

  const episodeTitle = cleanTitle(match.after.replace(/^[\s._-]+/, ''));
  return {
    kind: 'episode',
    // Files directly in the library root are grouped by their show name.
    itemPath: showFolder ?? show.title,
    showTitle: show.title,
    ...(show.year && { showYear: show.year }),
    ids: { ...fileHints, ...source.ids },
    ...(season !== undefined && { season }),
    episodes: match.episodes,
    ...(match.absolute !== undefined && { absolute: match.absolute }),
    ...(episodeTitle && { episodeTitle }),
  };
}

/** Parses a file path relative to its library folder ("/"-separated). */
export function parseLibraryPath(kind: LibraryKind, relPath: string): ParsedFile {
  const segments = relPath.split('/');
  const fileName = segments.at(-1) ?? '';
  if (segments.some(isHidden)) return { kind: 'skip', reason: 'hidden' };
  if (!isVideoFile(fileName)) return { kind: 'skip', reason: 'not a video file' };
  if (isExtra(segments, stripExtension(fileName))) return { kind: 'skip', reason: 'extra' };

  if (kind === 'MOVIES') return parseMovie(relPath);
  const episode = parseEpisode(relPath);
  // Anime libraries can hold films next to series.
  if (episode.kind === 'skip' && kind === 'ANIME') return parseMovie(relPath);
  return episode;
}

/**
 * Title, year and id hints from an item's own name: a movie or show folder
 * ("Mr. Robot", "A Legend (2024)") or a loose movie file. Used to search again
 * after a wrong match replaced the title.
 */
export function parseItemName(name: string): { title: string; year?: number; ids: IdHints } {
  const base = isVideoFile(name) ? stripExtension(name) : name;
  const { ids, rest } = extractIdHints(base);
  const parsed = splitTitleYear(rest);
  return { title: parsed.title || base, ...(parsed.year && { year: parsed.year }), ids };
}
