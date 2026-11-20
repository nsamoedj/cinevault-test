// Subtitle files next to a video, named like Plex expects them:
// "Film (2020).srt", "Film (2020).nl.srt", "Film (2020).en.forced.srt",
// "Film (2020).eng.sdh.ass". Only read, never written (CLAUDE.md).

import { languageCode, type SubtitleFormat, subtitleFormat } from '@cinevault/shared';

export interface Sidecar {
  /** File name in the video's folder. */
  name: string;
  format: SubtitleFormat;
  /** ISO 639-2, when the name says. */
  language?: string;
  forced: boolean;
  hearingImpaired: boolean;
  /** Words in the name that are neither a language nor a flag, e.g. "Commentary". */
  label?: string;
}

const FORCED = new Set(['forced', 'foreign']);
// Not "hi": that is also Hindi.
const HEARING_IMPAIRED = new Set(['sdh', 'cc']);
const IGNORED = new Set(['default', 'full']);

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The subtitle files among `names` that belong to the video `videoName`. */
export function matchSidecars(videoName: string, names: string[]): Sidecar[] {
  const base = stripExtension(videoName).toLowerCase();
  const sidecars: Sidecar[] = [];
  for (const name of names) {
    const format = subtitleFormat(name);
    if (!format) continue;
    const stem = stripExtension(name);
    const lower = stem.toLowerCase();
    if (lower !== base && !lower.startsWith(`${base}.`)) continue;
    const tokens = stem.slice(base.length).split('.').filter(Boolean);
    let language: string | undefined;
    let forced = false;
    let hearingImpaired = false;
    const rest: string[] = [];
    for (const token of tokens) {
      const key = token.toLowerCase();
      if (FORCED.has(key)) forced = true;
      else if (HEARING_IMPAIRED.has(key)) hearingImpaired = true;
      else if (!language && languageCode(key)) language = languageCode(key);
      else if (!IGNORED.has(key)) rest.push(token);
    }
    sidecars.push({
      name,
      format,
      ...(language && { language }),
      forced,
      hearingImpaired,
      ...(rest.length > 0 && { label: rest.join(' ') }),
    });
  }
  return sidecars.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
