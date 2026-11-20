// Finding the intro: the stretch of audio two episodes share near their
// start (the theme tune), from the transcoder's fingerprints (one 32-bit
// value per 0.031 s, apps/transcoder/src/fingerprint.ts; older ones per
// 0.124 s). Or a chapter
// called "Intro" or "Opening". The end credits the same way, near the end
// (the closing song), or a chapter called "Credits" or "Ending".
//
// Like an audio search: equal values vote for a shift between the two
// episodes; along the best shifts, frames that differ in a few bits at most
// count as the same, and runs of them a few seconds apart (talk over the
// tune) are one shared part. The episodes vote on the parts they share.

export interface Segment {
  /** Seconds, in the first episode. */
  start: number;
  end: number;
  /** Where the same part is in the other episode. */
  otherStart: number;
}

export interface Chapter {
  start: number;
  end: number;
  title?: string;
}

/** Bits two frames may differ in and still be the same audio (of 32). */
const MAX_BITS = 8;
/** Seconds of difference allowed inside a run (noise, a sound effect over the tune). */
const MAX_GAP_SECONDS = 1.24;
/** Shifts to try, from the most votes down. */
const SHIFTS = 12;
/** A value more common than this (in seconds of frames) in one episode (e.g. silence) gets no vote. */
const COMMON_SECONDS = 3.72;

/** The frame counts for a fingerprint's hop. */
function framesFor(hop: number) {
  return {
    gap: Math.max(1, Math.round(MAX_GAP_SECONDS / hop)),
    common: Math.max(1, Math.round(COMMON_SECONDS / hop)),
    /** Shifts closer than this are the same match (a frame or so either way). */
    near: Math.max(1, Math.round(0.07 / hop)),
    /** The edges of a run: where at least half of this many frames match. */
    edge: Math.max(2, Math.round(0.5 / hop)),
  };
}

/**
 * A run without loose ends: a frame that matches by chance (in noise, a
 * gap's width before or after the shared part) moves its edge. The run starts
 * where most of the next half second matches, and ends after the last such
 * stretch.
 */
function tighten(
  a: Uint32Array,
  b: Uint32Array,
  shift: number,
  run: { start: number; end: number; matched: number },
  edge: number,
): { start: number; end: number; matched: number } {
  const same = (i: number) => {
    const x = a[i] as number;
    const y = b[i + shift] as number;
    return !(x === 0 && y === 0) && popcount(x ^ y) <= MAX_BITS;
  };
  const dense = (from: number, to: number) => {
    let n = 0;
    for (let i = from; i < to; i++) if (same(i)) n++;
    return n * 2 >= to - from;
  };
  let start = run.start;
  while (start < run.end - edge && !(same(start) && dense(start, start + edge))) start++;
  let end = run.end;
  while (end > start + edge && !(same(end - 1) && dense(end - edge, end))) end--;
  if (start === run.start && end === run.end) return run;
  let matched = 0;
  for (let i = start; i < end; i++) if (same(i)) matched++;
  return { start, end, matched };
}

export const MIN_INTRO_SECONDS = 12;
export const MAX_INTRO_SECONDS = 150;
/** End credits: a closing song is often longer than a theme tune (and some credits run 10 minutes). */
export const CREDITS_LIMITS = { min: 15, max: 600 };

export function decodeFrames(base64: string): Uint32Array {
  const buffer = Buffer.from(base64, 'base64');
  const frames = new Uint32Array(Math.floor(buffer.length / 4));
  for (let i = 0; i < frames.length; i++) frames[i] = buffer.readUInt32LE(i * 4);
  return frames;
}

function popcount(x: number): number {
  let n = x - ((x >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** The shifts (b index minus a index) that equal values point to most. */
function candidateShifts(a: Uint32Array, b: Uint32Array, hop: number): number[] {
  const { common, near } = framesFor(hop);
  const where = indexOf(b, common);
  const votes = new Map<number, number>();
  a.forEach((value, i) => {
    for (const j of where.get(value) ?? []) votes.set(j - i, (votes.get(j - i) ?? 0) + 1);
  });
  // Neighbouring shifts are the same match, give or take a frame.
  const merged = new Map<number, number>();
  for (const [shift, count] of votes) {
    let total = count;
    for (let d = 1; d <= near; d++) {
      total += (votes.get(shift - d) ?? 0) + (votes.get(shift + d) ?? 0);
    }
    merged.set(shift, total);
  }
  // The best shifts, one per match (its neighbours would only take places).
  const chosen: number[] = [];
  for (const [shift, count] of [...merged.entries()].sort((x, y) => y[1] - x[1])) {
    if (count < 3 || chosen.length >= SHIFTS) break;
    if (chosen.some((c) => Math.abs(c - shift) <= near)) continue;
    chosen.push(shift);
  }
  return chosen;
}

/**
 * Pieces along one shift may be this far apart and still be one part: the
 * tune under a line of dialogue, a sound effect or a cut to silence breaks it
 * into pieces at the same place in both episodes.
 */
const BRIDGE_SECONDS = 6;
/** A piece of a part: this long at least (shorter ones are chance matches). */
const MIN_PIECE_SECONDS = 1.5;
/** A part made of pieces: this share of its frames must match (each piece alone 60%). */
const BRIDGED_SHARE = 0.4;

/**
 * Every part `a` and `b` share, as an intro would be: at least
 * MIN_INTRO_SECONDS, at most MAX_INTRO_SECONDS (a longer match is the same
 * episode twice, or a recap), and mostly matching frames; the longest first,
 * one per place in `a`. Credits pass their own limits.
 *
 * Along each of the best shifts, the pieces that match (a gap of at most
 * MAX_GAP_SECONDS inside) are joined when they are at most BRIDGE_SECONDS
 * apart; the longest such part within the limits counts for that shift, so a
 * longer match along it (two episodes that share more) doesn't hide it.
 */
export function sharedSegments(
  a: Uint32Array,
  b: Uint32Array,
  hop: number,
  limits = { min: MIN_INTRO_SECONDS, max: MAX_INTRO_SECONDS },
): Segment[] {
  const { gap, edge } = framesFor(hop);
  const bridge = Math.round(BRIDGE_SECONDS / hop);
  const minPiece = Math.round(MIN_PIECE_SECONDS / hop);
  const min = limits.min / hop;
  const max = limits.max / hop;
  const found: { start: number; end: number; shift: number }[] = [];
  for (const shift of candidateShifts(a, b, hop)) {
    const pieces = runsAlong(a, b, shift, 0, a.length, gap)
      .map((run) => tighten(a, b, shift, run, edge))
      .filter((run) => {
        const length = run.end - run.start;
        return length >= minPiece && run.matched >= length * 0.6;
      });
    let best: { start: number; end: number } | undefined;
    for (let i = 0; i < pieces.length; i++) {
      let matched = 0;
      for (let j = i; j < pieces.length; j++) {
        const first = pieces[i] as (typeof pieces)[number];
        const last = pieces[j] as (typeof pieces)[number];
        if (j > i && last.start - (pieces[j - 1] as (typeof pieces)[number]).end > bridge) break;
        matched += last.matched;
        const length = last.end - first.start;
        if (length > max) break;
        if (length < min || (j > i && matched < length * BRIDGED_SHARE)) continue;
        if (!best || length > best.end - best.start) best = { start: first.start, end: last.end };
      }
    }
    if (best) found.push({ ...best, shift });
  }
  // The same part along neighbouring shifts: the longest.
  found.sort((x, y) => y.end - y.start - (x.end - x.start));
  const kept: typeof found = [];
  for (const part of found) {
    if (kept.some((k) => part.start < k.end && k.start < part.end)) continue;
    kept.push(part);
  }
  return kept.map((part) => ({
    start: part.start * hop,
    end: part.end * hop,
    otherStart: (part.start + part.shift) * hop,
  }));
}

/** The longest part `a` and `b` share (sharedSegments). */
export function sharedSegment(
  a: Uint32Array,
  b: Uint32Array,
  hop: number,
  limits = { min: MIN_INTRO_SECONDS, max: MAX_INTRO_SECONDS },
): Segment | undefined {
  return sharedSegments(a, b, hop, limits)[0];
}

/** Two parts are the same intro: both ends within 5 s, or overlapping for 75% of the longer. */
function agrees(x: Range, y: Range): boolean {
  if (Math.abs(x.start - y.start) < 5 && Math.abs(x.end - y.end) < 5) return true;
  const overlap = Math.min(x.end, y.end) - Math.max(x.start, y.start);
  return overlap >= 0.75 * Math.max(x.end - x.start, y.end - y.start);
}

/**
 * The intro (or the credits) of an episode from the parts it shares with
 * other episodes, a list per episode: the part most of them have (a match
 * with one episode can be a song both happen to use, or a scene the next
 * one replays), the longest when they disagree.
 */
export function pickShared(
  perEpisode: Segment[][],
): (Range & { /** How many of the episodes have it. */ agree: number }) | undefined {
  const scored = perEpisode.flatMap((parts, k) =>
    parts.map((segment) => ({
      segment,
      agree: perEpisode.filter((other, m) => m === k || other.some((o) => agrees(o, segment)))
        .length,
    })),
  );
  scored.sort(
    (x, y) =>
      y.agree - x.agree || y.segment.end - y.segment.start - (x.segment.end - x.segment.start),
  );
  const best = scored[0];
  return best && { start: best.segment.start, end: best.segment.end, agree: best.agree };
}

/** pickShared with one part per episode. */
export function pickIntro(segments: Segment[]): Range | undefined {
  const picked = pickShared(segments.map((segment) => [segment]));
  return picked && { start: picked.start, end: picked.end };
}

/**
 * How sure an intro (or credits) from the audio is: the share of the
 * episodes compared that have it. One other episode is never enough for
 * more than a half.
 */
export function sharedConfidence(agree: number, compared: number): number {
  return Math.min(1, agree / Math.max(2, compared));
}

const INTRO_CHAPTER =
  /^((intro|opening|op)(\s*\d+)?(\s+(song|theme|credits|titles|sequence))?|main titles?|title sequence|theme song)$/i;

/** A chapter that says it is the intro ("Intro", "Opening", "OP"), of a sensible length. */
export function introChapter(chapters: Chapter[]): { start: number; end: number } | undefined {
  const chapter = chapters.find((c) => c.title && INTRO_CHAPTER.test(c.title.trim()));
  if (!chapter) return undefined;
  const length = chapter.end - chapter.start;
  if (length < 5 || length > 240) return undefined;
  return { start: chapter.start, end: chapter.end };
}

const CREDITS_CHAPTER =
  /^(credits|end credits|closing credits|ending credits|(ending|ed)(\s*\d+)?(\s+(song|theme))?|outro|end titles?|closing titles?)$/i;

/** A chapter that says it is the end credits ("Credits", "Ending", "ED"), of a sensible length. */
export function creditsChapter(chapters: Chapter[]): { start: number; end: number } | undefined {
  const chapter = chapters.findLast((c) => c.title && CREDITS_CHAPTER.test(c.title.trim()));
  if (!chapter) return undefined;
  const length = chapter.end - chapter.start;
  if (length < 10 || length > 600) return undefined;
  return { start: chapter.start, end: chapter.end };
}

const RECAP_CHAPTER =
  /^(recap|previously|previously on\b.*|the story so far|story so far|vorige keer|eerder in\b.*|wat voorafging|résumé|zusammenfassung|was bisher geschah)$/i;

/** A chapter that says it is the recap ("Recap", "Previously on…"), of a sensible length. */
export function recapChapter(chapters: Chapter[]): { start: number; end: number } | undefined {
  const chapter = chapters.find((c) => c.title && RECAP_CHAPTER.test(c.title.trim()));
  if (!chapter) return undefined;
  const length = chapter.end - chapter.start;
  if (length < 5 || length > 360) return undefined;
  return { start: chapter.start, end: chapter.end };
}

/** A recap: how long it may be, in seconds. */
export const RECAP_LIMITS = { min: 15, max: 300 };
/** A clip of the episode before: at least this long (a recap is a string of short clips). */
const MIN_CLIP_SECONDS = 1.5;
/** Clips this far apart (or closer) are one recap. */
const RECAP_GAP_SECONDS = 15;
/** Windows of the episode's start (seconds) that vote for their own shifts (clips each have one). */
const WINDOW_SECONDS = 6;
const WINDOW_STEP_SECONDS = 3;

/** Where equal values are in `b`, for the votes; values too common (silence, a hum) left out. */
function indexOf(b: Uint32Array, common: number): Map<number, number[]> {
  const where = new Map<number, number[]>();
  b.forEach((value, j) => {
    if (value === 0) return;
    const list = where.get(value);
    if (list) list.push(j);
    else where.set(value, [j]);
  });
  for (const [value, list] of where) if (list.length > common) where.delete(value);
  return where;
}

/** Every run along one shift within [from, to) of `a` (silence neither counts nor breaks a run). */
function runsAlong(
  a: Uint32Array,
  b: Uint32Array,
  shift: number,
  from: number,
  to: number,
  gap: number,
): { start: number; end: number; matched: number }[] {
  const runs: { start: number; end: number; matched: number }[] = [];
  let start = -1;
  let last = -1;
  let matched = 0;
  const close = () => {
    if (start >= 0) runs.push({ start, end: last + 1, matched });
  };
  for (let i = Math.max(from, -shift); i < Math.min(to, a.length, b.length - shift); i++) {
    const x = a[i] as number;
    const y = b[i + shift] as number;
    if (x === 0 && y === 0) continue;
    if (popcount(x ^ y) <= MAX_BITS) {
      if (start < 0 || i - last > gap) {
        close();
        start = i;
        matched = 0;
      }
      last = i;
      matched++;
    }
  }
  close();
  return runs;
}

/**
 * The parts of `a` (frames from `limit` on are left out) that are also
 * somewhere in `b`, each at its own place: the clips a recap is made of.
 * Seconds in `a`, and where in `b`.
 */
export function sharedClips(
  a: Uint32Array,
  b: Uint32Array,
  hop: number,
  limit = a.length,
): Segment[] {
  const end = Math.min(limit, a.length);
  const { gap, common, near, edge } = framesFor(hop);
  const where = indexOf(b, common);
  const minFrames = Math.ceil(MIN_CLIP_SECONDS / hop);
  const windowFrames = Math.max(1, Math.round(WINDOW_SECONDS / hop));
  const windowStep = Math.max(1, Math.round(WINDOW_STEP_SECONDS / hop));
  const clips: { start: number; end: number; shift: number }[] = [];
  const tried = new Set<number>();
  for (let w = 0; w < end; w += windowStep) {
    const votes = new Map<number, number>();
    for (let i = w; i < Math.min(end, w + windowFrames); i++) {
      for (const j of where.get(a[i] as number) ?? []) {
        votes.set(j - i, (votes.get(j - i) ?? 0) + 1);
      }
    }
    for (const [shift, count] of votes) {
      let total = count;
      for (let d = 1; d <= near; d++) {
        total += (votes.get(shift - d) ?? 0) + (votes.get(shift + d) ?? 0);
      }
      if (total < 3 || tried.has(shift)) continue;
      tried.add(shift);
      for (const found of runsAlong(a, b, shift, 0, end, gap)) {
        const run = tighten(a, b, shift, found, edge);
        const length = run.end - run.start;
        if (length >= minFrames && run.matched >= length * 0.6) clips.push({ ...run, shift });
      }
    }
  }
  // The same clip, found along neighbouring shifts: keep the longest.
  clips.sort((x, y) => y.end - y.start - (x.end - x.start));
  const kept: typeof clips = [];
  for (const clip of clips) {
    if (kept.some((k) => clip.start < k.end && k.start < clip.end)) continue;
    kept.push(clip);
  }
  return kept
    .sort((x, y) => x.start - y.start)
    .map((c) => ({
      start: c.start * hop,
      end: c.end * hop,
      otherStart: (c.start + c.shift) * hop,
    }));
}

/** A clip of this episode's start found in an earlier one: `episode` 0 is the one before, 1 the one before that… */
export interface RecapClip extends Segment {
  episode?: number;
}

type Range = { start: number; end: number };

export interface RecapInput {
  /** Clips of this episode's start found in the episodes before (seconds in both files). */
  clips: RecapClip[];
  /** This episode's intro and credits: what they share with the one before is no recap. */
  intro?: Range;
  credits?: Range;
  /** The episode before: its intro and credits (and what follows them, a preview). */
  previousIntro?: Range;
  previousCredits?: Range;
  /** The same for the episodes before that (clip.episode 1, 2…). */
  earlier?: { intro?: Range; credits?: Range }[];
}

/** A recap starts at the very start, or soon after the intro or a cold open. */
const RECAP_START_SECONDS = 90;

/**
 * The recap from the clips: a run of clips of the episode before near the
 * start, leaving out the intro and the credits (shared by every episode)
 * and what the episode before shows after its credits (a preview of this
 * one). Several clips from different places, or one long one.
 */
export function pickRecap(input: RecapInput): Range | undefined {
  const scored = scoreRecap(input);
  return scored && { start: scored.start, end: scored.end };
}

/** pickRecap, with how sure it is (0-1): many places that cover much of it is sure. */
export function scoreRecap(input: RecapInput): (Range & { confidence: number }) | undefined {
  const overlaps = (clip: Range, range?: Range) =>
    range !== undefined && clip.start < range.end + 1 && range.start - 1 < clip.end;
  const clips = input.clips.filter((clip) => {
    const other = { start: clip.otherStart, end: clip.otherStart + clip.end - clip.start };
    const episode = clip.episode ?? 0;
    const theirs =
      episode === 0
        ? { intro: input.previousIntro, credits: input.previousCredits }
        : input.earlier?.[episode - 1];
    if (overlaps(clip, input.intro) || overlaps(clip, input.credits)) return false;
    if (overlaps(other, theirs?.intro)) return false;
    if (theirs?.credits && other.end > theirs.credits.start) return false;
    return true;
  });
  const groups: RecapClip[][] = [];
  for (const clip of clips) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (group && last && clip.start - last.end <= RECAP_GAP_SECONDS) group.push(clip);
    else groups.push([clip]);
  }
  for (const group of groups) {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    const near =
      first.start <= RECAP_START_SECONDS ||
      (input.intro !== undefined && Math.abs(first.start - input.intro.end) <= RECAP_START_SECONDS);
    if (!near) continue;
    const span = last.end - first.start;
    const matched = group.reduce((n, c) => n + c.end - c.start, 0);
    const places = new Set(group.map((c) => `${c.episode ?? 0}:${Math.round(c.otherStart / 10)}`))
      .size;
    // Narration, a title card or music under it: clips from many places may cover less.
    const share = places >= 3 ? 0.25 : 0.4;
    if (span < RECAP_LIMITS.min || span > RECAP_LIMITS.max || matched < span * share) continue;
    if (places < 2 && matched < 30) continue;
    // A recap at the very start starts at 0; one that leads into the intro ends there.
    const start = first.start < 5 ? 0 : first.start;
    const end =
      input.intro && input.intro.start >= last.end && input.intro.start - last.end <= 8
        ? input.intro.start
        : last.end;
    const cover = matched / span;
    const confidence =
      places >= 3 ? (cover >= 0.4 ? 0.85 : 0.6) : places === 2 ? (cover >= 0.4 ? 0.7 : 0.55) : 0.5;
    return { start, end, confidence };
  }
  return undefined;
}

/** A preview of the next episode: how long it may be, in seconds. */
export const PREVIEW_LIMITS = { min: 8, max: 180 };

const PREVIEW_CHAPTER =
  /^(preview|next (episode|time)( preview)?|next time( on\b.*)?|coming up( next)?|yokoku|予告|volgende (keer|aflevering)|vorschau|aperçu)$/i;

/** A chapter that says it is the preview of the next episode ("Preview", "Next Episode"), the last one. */
export function previewChapter(chapters: Chapter[]): Range | undefined {
  const chapter = chapters.findLast((c) => c.title && PREVIEW_CHAPTER.test(c.title.trim()));
  if (!chapter) return undefined;
  const length = chapter.end - chapter.start;
  if (length < 5 || length > PREVIEW_LIMITS.max) return undefined;
  return { start: chapter.start, end: chapter.end };
}

export interface PreviewInput {
  /** Clips of this episode's end found in the next one (seconds in both files). */
  clips: Segment[];
  /** This episode: its length (seconds), intro and credits. */
  duration: number;
  intro?: Range;
  credits?: Range;
  /** The next episode: its intro, credits and recap (what it shares with this one is no preview). */
  nextIntro?: Range;
  nextCredits?: Range;
  nextRecap?: Range;
}

/**
 * The preview of the next episode ("Next time on…"): clips of the next one
 * near the end of this one, in or after the credits, or right before them.
 * Clips the next one plays in its recap (this episode's last scene, which it
 * replays) or in its intro and credits (the same in every episode) are none.
 */
export function pickPreview(input: PreviewInput): (Range & { confidence: number }) | undefined {
  const overlaps = (clip: Range, range?: Range) =>
    range !== undefined && clip.start < range.end + 1 && range.start - 1 < clip.end;
  const creditsStart = input.credits?.start;
  // Without its recap known: the next one's start before its intro may be one.
  const recap =
    input.nextRecap ??
    (input.nextIntro && input.nextIntro.start > 5
      ? { start: 0, end: input.nextIntro.start }
      : undefined);
  const clips = input.clips
    .filter((clip) => {
      const other = { start: clip.otherStart, end: clip.otherStart + clip.end - clip.start };
      if (overlaps(clip, input.intro)) return false;
      if (overlaps(other, input.nextIntro) || overlaps(other, input.nextCredits)) return false;
      const late = creditsStart !== undefined && clip.start >= creditsStart - 5;
      return late || !overlaps(other, recap);
    })
    .sort((a, b) => a.start - b.start);
  const groups: Segment[][] = [];
  for (const clip of clips) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (group && last && clip.start - last.end <= RECAP_GAP_SECONDS) group.push(clip);
    else groups.push([clip]);
  }
  for (const group of groups.reverse()) {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    const span = last.end - first.start;
    const matched = group.reduce((n, c) => n + c.end - c.start, 0);
    const places = new Set(group.map((c) => Math.round(c.otherStart / 10))).size;
    if (span < PREVIEW_LIMITS.min || span > PREVIEW_LIMITS.max || matched < span * 0.3) continue;
    if (places < 2 && matched < 15) continue;
    const inCredits = creditsStart !== undefined && first.start >= creditsStart - 5;
    const beforeCredits = creditsStart !== undefined && Math.abs(last.end - creditsStart) <= 15;
    const atEnd = last.end >= input.duration - 60;
    if (!inCredits && !beforeCredits && !atEnd) continue;
    // Up to the end of the file when it runs (almost) to it.
    const end = input.duration - last.end <= 5 ? input.duration : last.end;
    const confidence = places >= 2 ? (inCredits || atEnd ? 0.8 : 0.65) : 0.5;
    return { start: first.start, end, confidence };
  }
  return undefined;
}
