// Display helpers in Dutch, for the web app and the mobile app.

import {
  type CollectionPart,
  type CollectionSummary,
  type HealthLevel,
  type IntroStatus,
  type LibrarySummary,
  type LibraryType,
  MIN_MARKER_CONFIDENCE,
} from './index.js';

export const libraryTypeLabel: Record<LibraryType, string> = {
  MOVIES: 'Films',
  SHOWS: 'Series',
  ANIME: 'Anime',
};

/** Under a "Nieuwe afleveringen" card: "S2 · A5 · Titel", or "S2 · A1 · 8 nieuwe afleveringen". */
export function newEpisodesLabel(entry: {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  count: number;
}): string {
  const code = `S${entry.seasonNumber} · A${entry.episodeNumber}`;
  if (entry.count > 1) return `${code} · ${entry.count} nieuwe afleveringen`;
  return entry.title ? `${code} · ${entry.title}` : code;
}

/** Arrived in the last two weeks: a "Nieuw" flag on the card. */
export function isRecent(addedAt: string, now = Date.now()): boolean {
  return now - Date.parse(addedAt) < 14 * 86_400_000;
}

/** "Films", "Series", "Anime"; the library's own name when two have the same type. */
export function libraryLabel(
  library: Pick<LibrarySummary, 'type' | 'name'>,
  all: Pick<LibrarySummary, 'type'>[],
): string {
  return all.filter((l) => l.type === library.type).length > 1
    ? library.name
    : libraryTypeLabel[library.type];
}

const CODECS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  aac: 'AAC',
  ac3: 'Dolby Digital (AC3)',
  eac3: 'Dolby Digital Plus (E-AC3)',
  truehd: 'Dolby TrueHD',
  dts: 'DTS',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  subrip: 'SRT',
  ass: 'ASS',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  mov_text: 'MP4-tekst',
  webvtt: 'WebVTT',
  mkv: 'MKV',
  mp4: 'MP4',
  avi: 'AVI',
  ts: 'MPEG-TS',
};

export function codecLabel(codec: string | undefined): string {
  if (!codec) return 'onbekend';
  return CODECS[codec] ?? codec.toUpperCase();
}

const LANGUAGES: Record<string, string> = {
  nld: 'Nederlands',
  dut: 'Nederlands',
  eng: 'Engels',
  jpn: 'Japans',
  ger: 'Duits',
  deu: 'Duits',
  fre: 'Frans',
  fra: 'Frans',
  spa: 'Spaans',
  ita: 'Italiaans',
  kor: 'Koreaans',
  chi: 'Chinees',
  zho: 'Chinees',
  por: 'Portugees',
  rus: 'Russisch',
};

export function languageLabel(code: string | undefined): string {
  if (!code) return 'onbekende taal';
  const known = LANGUAGES[code.toLowerCase()];
  if (known) return known;
  try {
    const name = new Intl.DisplayNames(['nl'], { type: 'language' }).of(code);
    if (name && name !== code) return name;
  } catch {
    // Not a code Intl knows.
  }
  return code.toUpperCase();
}

export function channelsLabel(channels: number | undefined): string {
  switch (channels) {
    case undefined:
      return '';
    case 1:
      return 'mono';
    case 2:
      return 'stereo';
    case 6:
      return '5.1';
    case 8:
      return '7.1';
    default:
      return `${channels} kanalen`;
  }
}

export function resolutionLabel(width: number | undefined, height: number | undefined): string {
  if (!width || !height) return '';
  if (width >= 3200 || height > 1600) return '4K';
  if (width >= 1800 || height > 900) return '1080p';
  if (width >= 1200 || height > 600) return '720p';
  return 'SD';
}

export function durationLabel(ms: number | undefined): string {
  if (!ms) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} u ${minutes % 60} min`;
}

export function runtimeLabel(minutes: number | undefined): string {
  return minutes ? durationLabel(minutes * 60_000) : '';
}

export function sizeLabel(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString('nl-NL', { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
}

export function bitrateLabel(bps: number | undefined): string {
  if (!bps) return '';
  return `${(bps / 1_000_000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} Mbit/s`;
}

export function dateLabel(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function countLabel(count: number, one: string, many: string): string {
  return `${count.toLocaleString('nl-NL')} ${count === 1 ? one : many}`;
}

export function seasonLabel(season: number): string {
  return season === 0 ? 'Specials' : `Seizoen ${season}`;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function clockLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** "Vandaag", "Morgen", or "za 25 okt" for an air date (YYYY-MM-DD), in local time. */
export function airDateLabel(date: string, now = Date.now()): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const day = new Date(y, m - 1, d);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'Vandaag';
  if (days === 1) return 'Morgen';
  return `${DAYS[day.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

const DAYS_LONG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const MONTHS_LONG = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
];

/** A day in the calendar: "Vandaag", "Gisteren", "Morgen", or "woensdag 21 oktober". */
export function calendarDayLabel(date: string, now = Date.now()): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const day = new Date(y, m - 1, d);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'Vandaag';
  if (days === -1) return 'Gisteren';
  if (days === 1) return 'Morgen';
  const year = y === today.getFullYear() ? '' : ` ${y}`;
  return `${DAYS_LONG[day.getDay()]} ${d} ${MONTHS_LONG[m - 1]}${year}`;
}

/** Days since 1970 for a YYYY-MM-DD date (calendar arithmetic without time zones). */
function dayNumber(date: string): number | undefined {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** The YYYY-MM-DD date `days` after `date`. */
export function addDays(date: string, days: number): string {
  const start = dayNumber(date);
  if (start === undefined) return date;
  return new Date((start + days) * 86_400_000).toISOString().slice(0, 10);
}

/** One day in the calendar screen: the tile ("wo", 4, "nov") and how far away it is. */
export interface CalendarDayParts {
  /** "wo" */
  weekday: string;
  day: number;
  /** "nov" */
  month: string;
  /** "Vandaag", "Morgen", "Gisteren", "Donderdag" (within a week), else "12 december". */
  relative: string;
  /** "donderdag 6 november" (with the year when it isn't this year). */
  full: string;
  /** What goes under `relative` without repeating it: the full date under "Morgen", "6 november" under "Donderdag", "donderdag" under "12 december". */
  detail: string;
  /** Days from today (negative is past). */
  offset: number;
}

/** The parts of a day (YYYY-MM-DD), counted from the server's `today`. */
export function calendarDay(date: string, today: string): CalendarDayParts {
  const [y = 0, m = 1, d = 0] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const weekday = day.getUTCDay();
  const offset = (dayNumber(date) ?? 0) - (dayNumber(today) ?? 0);
  const year = today.slice(0, 4) === String(y) ? '' : ` ${y}`;
  const long = DAYS_LONG[weekday] ?? '';
  const full = `${long} ${d} ${MONTHS_LONG[m - 1]}${year}`;
  const dateText = `${d} ${MONTHS_LONG[m - 1]}${year}`;
  let relative: string;
  let detail: string;
  if (Math.abs(offset) <= 1) {
    relative = offset === 0 ? 'Vandaag' : offset === 1 ? 'Morgen' : 'Gisteren';
    detail = full;
  } else if (Math.abs(offset) < 7) {
    relative = long.charAt(0).toUpperCase() + long.slice(1);
    detail = dateText;
  } else {
    relative = dateText;
    detail = long;
  }
  return {
    weekday: DAYS[weekday] ?? '',
    day: d,
    month: MONTHS[m - 1] ?? '',
    relative,
    full,
    detail,
    offset,
  };
}

/** Under the calendar's title: "3 afleveringen deze week · 5 daarna". */
export function calendarSummary(entries: { airDate: string }[], today: string): string {
  const weekEnd = addDays(today, 6);
  const week = entries.filter((e) => e.airDate >= today && e.airDate <= weekEnd).length;
  const later = entries.filter((e) => e.airDate > weekEnd).length;
  if (week === 0 && later === 0) return 'Geen nieuwe afleveringen gepland';
  const first =
    week === 0
      ? 'Deze week niets'
      : `${week} ${week === 1 ? 'aflevering' : 'afleveringen'} deze week`;
  return later > 0 ? `${first} · ${later} daarna` : first;
}

/** A flag for the first episode of a season: "Nieuwe serie" or "Nieuw seizoen". */
export function premiereLabel(entry: {
  seasonNumber: number;
  episodeNumber: number;
}): string | undefined {
  if (entry.episodeNumber !== 1) return undefined;
  return entry.seasonNumber === 1 ? 'Nieuwe serie' : 'Nieuw seizoen';
}

/** Calendar entries per air date, in the order given. */
export function groupByDay<T extends { airDate: string }>(
  entries: T[],
): { date: string; entries: T[] }[] {
  const days: { date: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const last = days[days.length - 1];
    if (last?.date === entry.airDate) last.entries.push(entry);
    else days.push({ date: entry.airDate, entries: [entry] });
  }
  return days;
}

/** Under a "Binnenkort" card: "S4 · A3 · Titel". */
export function upcomingLabel(entry: {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
}): string {
  const code = `S${entry.seasonNumber} · A${entry.episodeNumber}`;
  return entry.title ? `${code} · ${entry.title}` : code;
}

/** The trailer on YouTube (the app or the site). */
export function trailerUrl(key: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;
}

/** The trailer to play inside a page (no cookies until it plays). */
export function trailerEmbedUrl(key: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0`;
}

/**
 * A TMDB backdrop at full size, for big screens (4K TVs): the API serves
 * "/tmdb/w1280/…" as 1280 px wide, "/tmdb/original/…" as it is (up to 3840).
 */
export function largeImage(url: string | undefined): string | undefined {
  return url?.replace('/api/images/tmdb/w1280/', '/api/images/tmdb/original/');
}

/** "Zojuist", "12 min geleden", "3 uur geleden", "Gisteren", "4 dagen geleden", "12 okt". */
export function timeAgoLabel(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'Zojuist';
  if (minutes < 60) return `${minutes} min geleden`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} uur geleden`;
  const day = new Date(then);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 1) return 'Gisteren';
  if (days < 7) return `${days} dagen geleden`;
  return `${day.getDate()} ${MONTHS[day.getMonth()]}`;
}

/** Kijkwijzer's label: "AL" for everyone, else the age. */
export function ageLabel(age: number): string {
  return age === 0 ? 'AL' : String(age);
}

/** The ages a kids profile can be limited to, as Kijkwijzer has them. */
export const KIDS_AGES = [0, 6, 9, 12, 14, 16] as const;

/** "45% · nog 12 min", "In de wachtrij", "Wordt verwerkt"… */
export function downloadLabel(download: {
  state: string;
  progress: number;
  timeLeftMs?: number;
  message?: string;
}): string {
  switch (download.state) {
    case 'queued':
      return 'In de wachtrij';
    case 'paused':
      return 'Gepauzeerd';
    case 'importing':
      return 'Bijna klaar';
    case 'failed':
      return download.message ? `Mislukt: ${download.message}` : 'Mislukt';
    case 'warning':
      return download.message ?? 'Er is een probleem';
  }
  const percent = `${Math.floor(download.progress * 100)}%`;
  if (!download.timeLeftMs) return percent;
  const minutes = Math.max(1, Math.round(download.timeLeftMs / 60_000));
  const left =
    minutes < 60
      ? `${minutes} min`
      : `${Math.floor(minutes / 60)} u${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${percent} · nog ${left}`;
}

/** Which episodes: "S2 · A5", "S2 · A5–A7", "3 afleveringen". */
export function downloadEpisodesLabel(
  episodes: { seasonNumber: number; episodeNumber: number }[] | undefined,
): string {
  if (!episodes || episodes.length === 0) return '';
  const first = episodes[0] as { seasonNumber: number; episodeNumber: number };
  const last = episodes[episodes.length - 1] as { seasonNumber: number; episodeNumber: number };
  if (episodes.length === 1) return `S${first.seasonNumber} · A${first.episodeNumber}`;
  const oneSeason = episodes.every((e) => e.seasonNumber === first.seasonNumber);
  const consecutive = episodes.every((e, i) => e.episodeNumber === first.episodeNumber + i);
  if (oneSeason && consecutive) {
    return `S${first.seasonNumber} · A${first.episodeNumber}–A${last.episodeNumber}`;
  }
  return `${episodes.length} afleveringen`;
}

/** "1, 2 en 4". */
function listing(values: string[]): string {
  return values.length <= 1
    ? (values[0] ?? '')
    : `${values.slice(0, -1).join(', ')} en ${values.at(-1)}`;
}

/** Episode numbers with runs shortened: [1, 2, 3, 5] → "A1–A3, A5". */
function episodeRuns(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] ?? 0;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i] ?? end;
    runs.push(end > start ? `A${start}–A${end}` : `A${start}`);
  }
  return runs.join(', ');
}

/**
 * What part of a show a request is for: "Seizoen 2 en 3", "S1 · A1–A3",
 * "Seizoen 2 · S3 · A1". Undefined: the whole show (or a film).
 */
export function requestPartsLabel(parts: {
  seasons?: number[];
  episodes?: { seasonNumber: number; episodeNumber: number }[];
}): string | undefined {
  const seasons = [...new Set(parts.seasons ?? [])].sort((a, b) => a - b);
  const bySeason = new Map<number, number[]>();
  for (const e of parts.episodes ?? []) {
    if (seasons.includes(e.seasonNumber)) continue;
    bySeason.set(e.seasonNumber, [...(bySeason.get(e.seasonNumber) ?? []), e.episodeNumber]);
  }
  const labels: string[] = [];
  if (seasons.length) {
    labels.push(
      `${seasons.length === 1 ? 'Seizoen' : 'Seizoenen'} ${listing(seasons.map(String))}`,
    );
  }
  for (const [season, episodes] of [...bySeason].sort((a, b) => a[0] - b[0])) {
    labels.push(`S${season} · ${episodeRuns(episodes)}`);
  }
  return labels.length ? labels.join(' · ') : undefined;
}

const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));

/** Beheer, while the intro search works on a file: "Nu: … (3 min)", and what it reads for it. */
export function introSearchLines(status: IntroStatus, now = Date.now()): string[] {
  const lines: string[] = [];
  if (status.current) {
    const since = status.currentSince ? ` (${minutesSince(status.currentSince, now)} min)` : '';
    lines.push(`Nu: ${status.current}${since}`);
  }
  if (status.reading) {
    const part = { start: 'het begin', middle: 'het midden', end: 'het eind' }[status.reading.part];
    const of = status.reading.path === status.current ? 'dit bestand' : status.reading.path;
    const { read, seconds } = status.reading;
    const far =
      read !== undefined && seconds ? `, ${Math.round((read / seconds) * 100)}% gelezen` : '';
    lines.push(`Leest ${part} van ${of} (${minutesSince(status.reading.since, now)} min${far})`);
  }
  if (status.rushStopped === 'transcoder') {
    lines.push(
      'Alles zoeken is gestopt: de transcoder antwoordde niet. Herstart hem met docker compose restart transcoder en start het opnieuw.',
    );
  } else if (status.rushStopped === 'stuck') {
    lines.push(
      'Alles zoeken is gestopt: één aflevering kon niet worden afgerond (zie het log van de API).',
    );
  }
  return lines;
}

/** Beheer → Gezondheid: a level in words. */
export const healthLevelLabel: Record<HealthLevel, string> = {
  ok: 'In orde',
  warning: 'Let op',
  error: 'Probleem',
  unknown: 'Onbekend',
};

/** A collection's films: "3 van 8 films · 2 gezien". */
export function collectionLabel(collection: CollectionSummary): string {
  const films = `${collection.owned} van ${collection.total} ${collection.total === 1 ? 'film' : 'films'}`;
  return collection.watched > 0 ? `${films} · ${collection.watched} gezien` : films;
}

/** A film of a collection that isn't here: asked for, announced, or not here. */
export function missingPartLabel(part: CollectionPart): string {
  if (part.requested) return 'Aangevraagd';
  if (part.released) return 'Niet in de bibliotheek';
  return part.releaseDate ? `Verschijnt ${part.releaseDate.slice(0, 4)}` : 'Aangekondigd';
}

/** A film of a collection that can be asked for (Ontdekken → Aanvragen). */
export function canRequestPart(part: CollectionPart): boolean {
  return !part.item && part.released && !part.requested;
}

/**
 * A film of a collection in Ontdekken: "Deze film" (the one open), its year,
 * "Verschijnt 2027", or "Aangekondigd" without a date.
 */
export function discoverPartLabel(
  part: { releaseDate?: string; year?: number },
  current: boolean,
  now = Date.now(),
): string {
  if (current) return 'Deze film';
  if (!part.releaseDate) return 'Aangekondigd';
  const today = new Date(now).toISOString().slice(0, 10);
  if (part.releaseDate > today) return `Verschijnt ${part.releaseDate.slice(0, 4)}`;
  return part.year ? String(part.year) : 'Film';
}

/** How sure the search is of a part, in words: "zeker (95%)" or "onzeker (30%): niet in de spelers". */
export function markerConfidenceLabel(confidence: number | undefined): string | undefined {
  if (confidence === undefined) return undefined;
  const percent = `${Math.round(confidence * 100)}%`;
  if (confidence < MIN_MARKER_CONFIDENCE) return `onzeker (${percent}): niet in de spelers`;
  return confidence >= 0.8 ? `zeker (${percent})` : `redelijk zeker (${percent})`;
}
