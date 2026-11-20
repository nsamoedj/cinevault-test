// Skip Intro and the end credits: when the players show the button or the
// next-episode card, and where they go.

import type { IntroRange, MarkerKind, SkipSettings } from './index.js';

/** The button goes away this long before the intro's end: skipping would gain nothing. */
const BEFORE_END = 3;

/** True while `position` (seconds) is in the intro, so "Intro overslaan" is shown. */
export function inIntro(intro: IntroRange | undefined, position: number): boolean {
  if (!intro) return false;
  return position >= intro.startMs / 1000 - 0.5 && position < intro.endMs / 1000 - BEFORE_END;
}

/** "Recap overslaan" shows the same way: from the start of the recap until shortly before its end. */
export function inRecap(recap: IntroRange | undefined, position: number): boolean {
  return inIntro(recap, position);
}

/** Where "Intro overslaan" goes: the end of the intro (seconds). */
export function introEnd(intro: IntroRange): number {
  return intro.endMs / 1000;
}

/** A scene after the credits needs at least this much (seconds) to be worth staying for. */
const AFTER_CREDITS = 20;

/**
 * True from the start of the end credits: the players show "Volgende
 * aflevering" (with a countdown), or "Aftiteling overslaan" when a scene follows.
 */
export function inCredits(credits: IntroRange | undefined, position: number): boolean {
  if (!credits) return false;
  return position >= credits.startMs / 1000 - 0.5 && position < credits.endMs / 1000;
}

/** Where "Aftiteling overslaan" goes: the scene after the credits, if there is one. */
export function afterCredits(
  credits: IntroRange,
  durationSeconds: number,
  minScene = AFTER_CREDITS,
): number | undefined {
  const end = credits.endMs / 1000;
  return durationSeconds - end >= minScene ? end : undefined;
}

/**
 * A film's credits come from the picture, which stops them at any scene: a
 * scene after them may be short (a few seconds), and is never skipped.
 */
const AFTER_PICTURE_CREDITS = 4;

/**
 * Where "Aftiteling overslaan" goes from `position` when there is no next
 * episode: the end of the part of the credits playing now (a film can have
 * more, with a scene between), if a scene follows it; else nothing.
 */
export function skipCreditsTo(
  info: {
    credits?: IntroRange | undefined;
    creditsSource?: string | undefined;
    moreCredits?: IntroRange[] | undefined;
  },
  position: number,
  durationSeconds: number,
): number | undefined {
  const parts = [...(info.credits ? [info.credits] : []), ...(info.moreCredits ?? [])];
  const part = parts.find((p) => inCredits(p, position));
  if (!part) return undefined;
  const minScene = info.creditsSource === 'picture' ? AFTER_PICTURE_CREDITS : AFTER_CREDITS;
  return afterCredits(part, durationSeconds, minScene);
}

/** "Preview overslaan" (the next episode's preview) shows like the intro button. */
export function inPreview(preview: IntroRange | undefined, position: number): boolean {
  return inIntro(preview, position);
}

/**
 * The skip button shows this long when its part starts, then goes away; it
 * comes back with the controls (a tap, a key, the mouse).
 */
export const SKIP_BUTTON_MS = 8_000;

/** What the players know of an episode's parts (FileContext and IntroInfo both fit). */
export interface SkipParts {
  intro?: IntroRange | undefined;
  recap?: IntroRange | undefined;
  credits?: IntroRange | undefined;
  creditsSource?: string | undefined;
  moreCredits?: IntroRange[] | undefined;
  preview?: IntroRange | undefined;
}

/** The skip button of the moment: which part, its label, and where it goes (seconds). */
export interface SkipChoice {
  kind: MarkerKind;
  label: string;
  to: number;
  /** The same part, also after a new stream: for the 8 seconds and the auto-skip. */
  key: string;
}

/** Where skipping the preview goes: its end, or the end of the file when it runs (almost) to it. */
function previewTo(preview: IntroRange, duration: number): number {
  const end = preview.endMs / 1000;
  return duration > 0 && duration - end < 1 ? duration : end;
}

/**
 * The one skip button to show at `position`: the intro, the recap, the
 * preview, or (without a next episode, whose card covers the credits) the
 * credits when a scene follows them.
 */
export function skipChoice(
  parts: SkipParts,
  position: number,
  duration: number,
  hasNext: boolean,
): SkipChoice | undefined {
  if (parts.intro && inIntro(parts.intro, position)) {
    return {
      kind: 'intro',
      label: 'Intro overslaan',
      to: introEnd(parts.intro),
      key: `intro:${parts.intro.startMs}`,
    };
  }
  if (parts.recap && inRecap(parts.recap, position)) {
    return {
      kind: 'recap',
      label: 'Recap overslaan',
      to: introEnd(parts.recap),
      key: `recap:${parts.recap.startMs}`,
    };
  }
  if (parts.preview && inPreview(parts.preview, position)) {
    return {
      kind: 'preview',
      label: 'Preview overslaan',
      to: previewTo(parts.preview, duration),
      key: `preview:${parts.preview.startMs}`,
    };
  }
  if (!hasNext) {
    const to = skipCreditsTo(parts, position, duration);
    if (to !== undefined) {
      return { kind: 'credits', label: 'Aftiteling overslaan', to, key: `credits:${to}` };
    }
  }
  return undefined;
}

/**
 * What to skip by itself at `position` for a profile's SkipSettings: a part
 * to seek past, or (the credits, with a next episode) that episode now.
 * Once per part per play: `done` holds the keys already skipped, so seeking
 * back into a part shows the button instead.
 */
export function autoSkip(
  parts: SkipParts,
  position: number,
  duration: number,
  hasNext: boolean,
  settings: SkipSettings | undefined,
  done: ReadonlySet<string>,
): { kind: MarkerKind; key: string; to?: number; next?: true } | undefined {
  if (!settings) return undefined;
  const choice = skipChoice(parts, position, duration, hasNext);
  if (choice && choice.kind !== 'credits' && settings[choice.kind] && !done.has(choice.key)) {
    return { kind: choice.kind, key: choice.key, to: choice.to };
  }
  if (settings.credits && parts.credits && inCredits(parts.credits, position)) {
    const key = `credits:${parts.credits.startMs}`;
    if (done.has(key)) return undefined;
    if (hasNext) return { kind: 'credits', key, next: true };
    const to = skipCreditsTo(parts, position, duration);
    if (to !== undefined) return { kind: 'credits', key, to };
  }
  return undefined;
}
