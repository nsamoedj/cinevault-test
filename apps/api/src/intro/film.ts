// The end credits of a film, from the picture: the transcoder measures the
// keyframes in the last part of the film (apps/transcoder/src/frames.ts), and
// this decides. Rolling credits are dark frames with a little light text in
// lines; black frames between cards belong to them.
//
// A post-credit scene is never skipped: anything else on screen for a few
// seconds ends the credits there, and credits after that scene are a part of
// their own (Skip Credits again). Only a single stray frame (a logo, a frame
// misread) stays inside the credits.

export interface FrameSample {
  /** The time asked for, and the keyframe the transcoder used (at or before it). */
  time: number;
  at: number;
  dark: number;
  mid: number;
  bright: number;
  rows: number;
  perRow: number;
}

export type FrameKind = 'credits' | 'black' | 'other';

export interface Range {
  start: number;
  end: number;
}

/** One sample every this many seconds. */
export const STEP_SECONDS = 4;
/** The last part of a film: 20%, at least 5 and at most 20 minutes; longer credits look further back. */
const WINDOW = { share: 0.2, min: 300, max: 1200 };
/** Looked at when the credits already run at the start of the window. */
export const EXTEND_SECONDS = 600;
/** Credits never start before this part of the film. */
const EARLIEST_SHARE = 0.5;
/** A part of the credits: at least this many credit frames over this many seconds. */
const MIN_FRAMES = 3;
const MIN_SECONDS = 20;
/** Something else this long (or on two keyframes) is a scene: the credits end there. */
const SCENE_SECONDS = 6;
/** Black just before the first credits (a fade) belongs to them. */
const FADE_SECONDS = 10;

/** What a frame shows: credits, black, or anything else. */
export function frameKind(
  s: Pick<FrameSample, 'dark' | 'mid' | 'bright' | 'rows' | 'perRow'>,
): FrameKind {
  if (s.dark >= 0.995 && s.bright < 0.0005) return 'black';
  const text =
    s.dark >= 0.8 &&
    s.bright >= 0.0015 &&
    s.bright <= 0.15 &&
    // Letters are sharp: few grey pixels around them. A dark scene has its shades.
    s.mid <= 2 * s.bright + 0.03 &&
    // Lines of text, not a lamp or the stars.
    s.rows >= 2 &&
    s.perRow >= 4;
  return text ? 'credits' : 'other';
}

/** Where the search starts: the last part of the film. */
export function windowStart(duration: number): number {
  const seconds = Math.min(WINDOW.max, Math.max(WINDOW.min, duration * WINDOW.share));
  return Math.max(duration * EARLIEST_SHARE, duration - seconds);
}

/** The times to measure, from `from` to just before `to`. */
export function sampleTimes(from: number, to: number): number[] {
  const times: number[] = [];
  for (let t = from; t < to - 1; t += STEP_SECONDS) times.push(Math.round(t * 10) / 10);
  return times;
}

/**
 * The parts of the end credits, in order: the first is "the credits" (the
 * film counts as watched from there), the others come after a scene.
 */
export function filmCredits(samples: FrameSample[], duration: number): Range[] {
  // One point per keyframe (several times can land on the same one).
  const points = [...new Map(samples.map((s) => [s.at, s])).values()]
    .sort((a, b) => a.at - b.at)
    .map((s) => ({ at: s.at, kind: frameKind(s) }));
  const parts: Range[] = [];
  let current: { start: number; first: number; last: number; frames: number } | undefined;
  const close = (end: number) => {
    if (current && current.frames >= MIN_FRAMES && current.last - current.first >= MIN_SECONDS) {
      parts.push({ start: current.start, end: Math.min(end, duration) });
    }
    current = undefined;
  };
  for (let i = 0; i < points.length; i++) {
    const point = points[i] as (typeof points)[number];
    if (point.kind === 'credits') {
      if (!current) {
        // A fade to black just before: the credits start there.
        let start = point.at;
        for (let k = i - 1; k >= 0 && points[k]?.kind === 'black'; k--) {
          if (point.at - (points[k]?.at ?? 0) > FADE_SECONDS) break;
          start = points[k]?.at ?? start;
        }
        current = { start, first: point.at, last: point.at, frames: 0 };
      }
      current.last = point.at;
      current.frames++;
      continue;
    }
    if (point.kind === 'black') continue;
    // Something else: how long, up to the next frame that isn't.
    let j = i;
    while (j < points.length && points[j]?.kind === 'other') j++;
    const until = j < points.length ? (points[j]?.at ?? duration) : duration;
    if (j - i >= 2 || until - point.at >= SCENE_SECONDS) close(point.at);
    i = j - 1;
  }
  close(duration);
  return parts;
}
