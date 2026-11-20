// Viewing logic shared by the web app and the mobile app: where to resume,
// which subtitle to start with, and merging subtitle cues as they arrive.

import type { AudioTrack, EpisodeDto, ItemDetails, ProgressDto, SeasonDto } from './index.js';
import { type Cue, languageCode, type SubtitleOption } from './subtitles.js';

/** Seconds to start at: where the profile stopped, unless that was at the very start or end. */
export function resumePoint(progress: ProgressDto | undefined, durationSeconds: number): number {
  if (!progress) return 0;
  const position = progress.positionMs / 1000;
  const duration = (progress.durationMs ?? 0) / 1000 || durationSeconds;
  if (position < 60) return 0;
  if (duration && (position >= duration * 0.92 || duration - position <= 120)) return 0;
  return Math.floor(position);
}

/** Languages the household reads (owner: Dutch, English titles). */
const READ = ['nld', 'eng'];

/** Only signs and songs, by its flag or its name ("Signs & Songs", anime releases). */
const partial = (option: SubtitleOption) =>
  option.forced || /\bsigns?\b|\bsongs?\b|forced|geforceerd/i.test(option.label ?? '');

const byLanguage = (options: SubtitleOption[], language: string) =>
  // Full subtitles before forced ones (those only translate signs and foreign bits).
  options
    .filter((o) => o.supported && o.language === language)
    .sort((a, b) => Number(partial(a)) - Number(partial(b)))[0];

/**
 * The subtitle to start with:
 * - the one chosen for this show (TrackChoice.subtitle, on any device);
 * - otherwise the language chosen before on this device (or none, if switched off);
 * - otherwise, for audio in a language not read here (e.g. Japanese anime),
 *   Dutch or else English subtitles;
 * - otherwise forced subtitles in the audio's language, if the file has them.
 *
 * `preference` and `forShow` are "off", a language ("nld"), or undefined when
 * never chosen. A show's language the file does not have falls through.
 */
export function chooseSubtitle(
  options: SubtitleOption[],
  audioLanguage: string | undefined,
  preference: string | undefined,
  forShow?: string,
): SubtitleOption | undefined {
  if (forShow === 'off') return undefined;
  if (forShow) {
    const chosen = byLanguage(options, forShow);
    if (chosen) return chosen;
  }
  if (preference === 'off') return undefined;
  if (preference) {
    const preferred = byLanguage(options, preference);
    if (preferred) return preferred;
  }
  if (audioLanguage && !READ.includes(audioLanguage)) {
    for (const language of READ) {
      const found = byLanguage(options, language);
      if (found) return found;
    }
  }
  return options.find((o) => o.supported && o.forced && o.language === audioLanguage);
}

const COMMENTARY = /commentary|commentaar|kommentar/i;

/**
 * The audio track for a language chosen before (TrackChoice.audioLanguage):
 * its index, or undefined when the file's default track will do (or the
 * file has no track in that language). Commentary tracks only when nothing
 * else is in that language; the default track first, then the file's order.
 */
export function chooseAudioTrack(
  tracks: AudioTrack[],
  language: string | undefined,
): number | undefined {
  const wanted = languageCode(language);
  if (!wanted) return undefined;
  const inLanguage = tracks.filter((t) => languageCode(t.language) === wanted);
  const candidates = inLanguage.filter((t) => !COMMENTARY.test(t.title ?? ''));
  const found = [...(candidates.length ? candidates : inLanguage)].sort(
    (a, b) => Number(b.default) - Number(a.default),
  )[0];
  const fallback = tracks.find((t) => t.default) ?? tracks[0];
  if (!found || found.index === fallback?.index) return undefined;
  return found.index;
}

/** Adds cues read later (an embedded track read in pieces) without duplicates, in order. */
export function mergeCues(known: Cue[], added: Cue[]): Cue[] {
  const seen = new Set(known.map((c) => `${c.start}|${c.end}|${c.text}`));
  const merged = [...known];
  for (const cue of added) {
    const key = `${cue.start}|${cue.end}|${cue.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(cue);
    }
  }
  return merged.sort((a, b) => a.start - b.start);
}

/** The cues on screen at `seconds` (file time, after the viewer's shift). */
export function cuesAt(cues: Cue[], seconds: number): Cue[] {
  return cues.filter((cue) => cue.start <= seconds && seconds < cue.end);
}

/** Stopped halfway (past the first minute, before the credits). */
export function isResumable(progress: ProgressDto | undefined): progress is ProgressDto {
  if (!progress || progress.positionMs < 60_000) return false;
  return !(progress.durationMs && progress.positionMs > progress.durationMs * 0.92);
}

/** What "Afspelen" plays for a show: where the profile is, else the next or first episode. */
export function showStart(
  item: ItemDetails,
): { episode: EpisodeDto; season: SeasonDto } | undefined {
  const seasons = [...item.seasons]
    .filter((s) => s.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber);
  const episodes = seasons.flatMap((season) =>
    season.episodes.filter((e) => e.files.length > 0).map((episode) => ({ episode, season })),
  );
  const halfway = episodes.find(({ episode }) => isResumable(episode.progress));
  if (halfway) return halfway;
  const lastWatched = episodes.map((e) => e.episode.progress?.watched).lastIndexOf(true);
  return episodes[lastWatched + 1] ?? episodes[0];
}
