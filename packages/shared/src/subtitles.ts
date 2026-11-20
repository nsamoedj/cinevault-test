// Subtitles as plain cues, and conversion of SRT, ASS/SSA and WebVTT to
// WebVTT, the one format browsers (and the Expo player) show (CLAUDE.md,
// phase 6). Styling from ASS is dropped: positions, colours and fonts don't
// survive, the text does.

export interface Cue {
  /** Seconds from the start of the file. */
  start: number;
  end: number;
  text: string;
}

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa';

/** "01:02:03.456", "02:03.456", "01:02:03,456" (SRT) or "1:02:03.45" (ASS) → seconds. */
export function parseTimestamp(value: string): number | undefined {
  const match = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$/.exec(value);
  if (!match) return undefined;
  const [, h = '0', m = '0', s = '0', fraction = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${fraction}`);
}

function vttTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

function normalizeLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
}

/** Cues from blocks of "start --> end" plus text, as WebVTT and SRT both have. */
function parseBlocks(text: string, srt: boolean): Cue[] {
  const cues: Cue[] = [];
  const lines = normalizeLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.includes('-->')) continue;
    const [from = '', rest = ''] = line.split('-->');
    const start = parseTimestamp(from);
    const end = parseTimestamp(rest.trim().split(/\s+/)[0] ?? '');
    const body: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== '') body.push(lines[++i] ?? '');
    if (start === undefined || end === undefined || end <= start) continue;
    let cueText = body.join('\n');
    // SRT positioning codes such as {\an8} mean nothing to WebVTT.
    if (srt) cueText = cueText.replace(/\{\\[^}]*\}/g, '');
    cueText = cueText.trim();
    if (cueText) cues.push({ start, end, text: cueText });
  }
  return cues;
}

export function parseVtt(text: string): Cue[] {
  return parseBlocks(text, false);
}

export function parseSrt(text: string): Cue[] {
  return parseBlocks(text, true);
}

/** Dialogue lines from the [Events] section of an ASS/SSA file. */
export function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let inEvents = false;
  let fields = [
    'layer',
    'start',
    'end',
    'style',
    'name',
    'marginl',
    'marginr',
    'marginv',
    'effect',
    'text',
  ];
  for (const raw of normalizeLines(text)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inEvents = line.toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      fields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const values = line.slice(line.indexOf(':') + 1).split(',');
    // The text is the last field and may contain commas itself.
    const textIndex = fields.indexOf('text');
    const get = (name: string) => values[fields.indexOf(name)]?.trim() ?? '';
    const start = parseTimestamp(get('start'));
    const end = parseTimestamp(get('end'));
    const rawText = values.slice(textIndex).join(',');
    // Drawings (\p1 … \p0) are vector shapes, not text.
    if (start === undefined || end === undefined || end <= start || /\\p[1-9]/.test(rawText)) {
      continue;
    }
    const cueText = rawText
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
    if (cueText) cues.push({ start, end, text: cueText });
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function parseSubtitles(text: string, format: SubtitleFormat): Cue[] {
  switch (format) {
    case 'vtt':
      return parseVtt(text);
    case 'srt':
      return parseSrt(text);
    case 'ass':
    case 'ssa':
      return parseAss(text);
  }
}

/**
 * WebVTT text forbids "-->" and treats "<" and "&" as markup; keep the tags SRT uses.
 * Other tags (`<font color=…>`, common in downloaded SRTs) go, rather than show as text.
 */
function escapeCueText(text: string): string {
  return text
    .replace(/<\/?(?!(?:i|b|u)>)[a-z][^<>]*>/gi, '')
    .replace(/-->/g, '→')
    .replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;')
    .replace(/<(?!\/?(?:i|b|u)>)/gi, '&lt;');
}

export function cuesToVtt(cues: Cue[]): string {
  const blocks = cues.map(
    (cue) => `${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${escapeCueText(cue.text)}`,
  );
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}

export function toWebVtt(text: string, format: SubtitleFormat): string {
  return cuesToVtt(parseSubtitles(text, format));
}

/** The format of a subtitle file by its name, e.g. "Film (2020).nl.srt" → "srt". */
export function subtitleFormat(fileName: string): SubtitleFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return ext === 'srt' || ext === 'vtt' || ext === 'ass' || ext === 'ssa' ? ext : undefined;
}

// --- Languages ----------------------------------------------------------------

const LANGUAGES: [iso1: string, iso2: string, names: string[]][] = [
  ['nl', 'nld', ['dut', 'dutch', 'nederlands', 'vlaams', 'flemish']],
  ['en', 'eng', ['english', 'engels']],
  ['de', 'deu', ['ger', 'german', 'deutsch', 'duits']],
  ['fr', 'fra', ['fre', 'french', 'francais', 'frans']],
  ['es', 'spa', ['spanish', 'espanol', 'spaans']],
  ['it', 'ita', ['italian', 'italiano', 'italiaans']],
  ['pt', 'por', ['portuguese', 'portugees']],
  ['ja', 'jpn', ['japanese', 'japans']],
  ['ko', 'kor', ['korean', 'koreaans']],
  ['zh', 'zho', ['chi', 'chinese', 'chinees']],
  ['ru', 'rus', ['russian', 'russisch']],
  ['pl', 'pol', ['polish', 'pools']],
  ['tr', 'tur', ['turkish', 'turks']],
  ['sv', 'swe', ['swedish', 'zweeds']],
  ['no', 'nor', ['nob', 'norwegian', 'noors']],
  ['da', 'dan', ['danish', 'deens']],
  ['fi', 'fin', ['finnish', 'fins']],
  ['ar', 'ara', ['arabic', 'arabisch']],
  ['he', 'heb', ['hebrew', 'hebreeuws']],
  ['hi', 'hin', ['hindi']],
  ['id', 'ind', ['indonesian', 'indonesisch']],
];

/** A language code or name ("nl", "dut", "Dutch") as ISO 639-2 ("nld"); undefined when unknown. */
export function languageCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  const found = LANGUAGES.find(([a, b, names]) => a === key || b === key || names.includes(key));
  return found?.[1];
}

/** ISO 639-2 ("nld") as ISO 639-1 ("nl"), as OpenSubtitles wants. */
export function languageCode1(value: string | undefined): string | undefined {
  const iso2 = languageCode(value);
  return LANGUAGES.find(([, b]) => b === iso2)?.[0];
}

// --- API types ----------------------------------------------------------------

export type SubtitleSourceKind = 'embedded' | 'external' | 'opensubtitles';

/** A subtitle the player can offer for a file (GET /api/files/:id/subtitles). */
export interface SubtitleOption {
  /** "embedded:<stream index>" for tracks in the file, else the id of the stored subtitle. */
  id: string;
  source: SubtitleSourceKind;
  /** ISO 639-2, e.g. "nld" or "eng". */
  language?: string;
  label?: string;
  codec?: string;
  forced: boolean;
  hearingImpaired: boolean;
  /** Shift set by the viewer, in milliseconds (positive = later). */
  offsetMs: number;
  /** False for image subtitles (PGS, VobSub) until they are read as text (`ocr`). */
  supported: boolean;
  /** The whole subtitle as WebVTT, when available at once. */
  url?: string;
  /**
   * Embedded text tracks without `url` are read from the file while playing
   * (extract); a picture track with `ocr` has it for POST …/subtitles/ocr.
   */
  streamIndex?: number;
  /**
   * Picture subtitles (PGS) the server reads as text: "possible" (ask with
   * POST …/subtitles/ocr), "queued", "running" (`ocrProgress`), "failed", or
   * "done" (now a text subtitle like any other).
   */
  ocr?: SubtitleOcrState;
  /** 0-1 while it is read. */
  ocrProgress?: number;
  /** 0-1: an embedded track being read whole for a Chromecast (POST …/prepare). */
  readProgress?: number;
}

export type SubtitleOcrState = 'possible' | 'queued' | 'running' | 'failed' | 'done';

/** A picture subtitle the viewer can ask to have read as text (again, after a failure). */
export function canReadAsText(option: SubtitleOption): boolean {
  return (
    !option.supported &&
    option.streamIndex !== undefined &&
    (option.ocr === 'possible' || option.ocr === 'failed')
  );
}

/** The server reads one of these as text now: worth asking for the list again. */
export function readingAsText(options: SubtitleOption[]): boolean {
  return options.some((o) => o.ocr === 'queued' || o.ocr === 'running');
}

/** What a player says about a picture subtitle, or undefined for one it can show. */
export function pictureSubtitleNote(option: SubtitleOption): string | undefined {
  if (option.supported) return option.ocr === 'done' ? 'tekstherkenning' : undefined;
  switch (option.ocr) {
    case 'queued':
      return 'wacht op omzetten naar tekst';
    case 'running':
      return option.ocrProgress !== undefined
        ? `wordt omgezet naar tekst · ${Math.round(option.ocrProgress * 100)}%`
        : 'wordt omgezet naar tekst';
    case 'failed':
      return 'omzetten naar tekst lukte niet';
    case 'possible':
      return 'beeld, om te zetten naar tekst';
    default:
      return 'beeld: niet te tonen';
  }
}

/** A subtitle found at a provider (GET /api/files/:id/subtitles/search). */
export interface SubtitleSearchResult {
  /** Provider's id, for POST …/subtitles/download. */
  id: string;
  provider: 'opensubtitles';
  language?: string;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  /** Made for exactly this file (same hash), so the timing fits. */
  matchesFile: boolean;
  machineTranslated: boolean;
}

/** Reading an embedded track from the file, started at `start` seconds. */
export interface SubtitleExtraction {
  id: string;
  start: number;
}

/** What has been read so far (GET /api/subtitle-extractions/:id). */
export interface ExtractedSubtitles {
  vtt: string;
  /** Read up to this point in the file (seconds). */
  covered: number;
  /** Reached the end of the file. */
  complete: boolean;
}
