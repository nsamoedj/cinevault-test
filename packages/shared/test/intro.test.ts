import { describe, expect, it } from 'vitest';
import { afterCredits, autoSkip, inCredits, inIntro, introEnd, skipChoice } from '../src/intro.js';

describe('Skip Intro', () => {
  const intro = { startMs: 62_000, endMs: 152_000 };

  it('shows the button during the intro, not just before its end', () => {
    expect(inIntro(intro, 50)).toBe(false);
    expect(inIntro(intro, 61.6)).toBe(true);
    expect(inIntro(intro, 100)).toBe(true);
    expect(inIntro(intro, 148.9)).toBe(true);
    expect(inIntro(intro, 149.5)).toBe(false);
    expect(inIntro(undefined, 100)).toBe(false);
  });

  it('skips to the end of the intro', () => {
    expect(introEnd(intro)).toBe(152);
  });
});

describe('end credits', () => {
  const credits = { startMs: 1_260_000, endMs: 1_350_000 };

  it('shows the next-episode card from the start of the credits', () => {
    expect(inCredits(credits, 1_200)).toBe(false);
    expect(inCredits(credits, 1_260)).toBe(true);
    expect(inCredits(credits, 1_349)).toBe(true);
    expect(inCredits(credits, 1_350)).toBe(false);
    expect(inCredits(undefined, 1_300)).toBe(false);
  });

  it('skips to a scene after the credits, not to the very end', () => {
    expect(afterCredits(credits, 1_440)).toBe(1_350);
    expect(afterCredits(credits, 1_360)).toBeUndefined();
  });
});

describe('one skip button, and skipping by itself', () => {
  const parts = {
    recap: { startMs: 0, endMs: 40_000 },
    intro: { startMs: 40_000, endMs: 130_000 },
    credits: { startMs: 1_300_000, endMs: 1_380_000 },
    preview: { startMs: 1_385_000, endMs: 1_419_500 },
  };

  it('shows the button of the part that plays', () => {
    expect(skipChoice(parts, 10, 1420, true)).toMatchObject({ kind: 'recap', to: 40 });
    expect(skipChoice(parts, 60, 1420, true)).toMatchObject({
      kind: 'intro',
      label: 'Intro overslaan',
      to: 130,
    });
    // The preview up to the end of the file: to the very end (the next episode starts).
    expect(skipChoice(parts, 1390, 1420, true)).toMatchObject({
      kind: 'preview',
      label: 'Preview overslaan',
      to: 1420,
    });
    // The credits: the next-episode card covers them; without one, a scene after them.
    expect(skipChoice(parts, 1310, 1420, true)).toBeUndefined();
    expect(skipChoice({ credits: parts.credits }, 1310, 1420, false)).toMatchObject({
      kind: 'credits',
      to: 1380,
    });
    expect(skipChoice(parts, 600, 1420, true)).toBeUndefined();
  });

  it('skips by itself what the profile chose, once per part', () => {
    const settings = { intro: true, recap: false, credits: true, preview: false };
    expect(autoSkip(parts, 10, 1420, true, settings, new Set())).toBeUndefined();
    const intro = autoSkip(parts, 41, 1420, true, settings, new Set());
    expect(intro).toMatchObject({ kind: 'intro', to: 130 });
    // Back into the intro after it skipped: the viewer's choice, the button shows.
    expect(autoSkip(parts, 41, 1420, true, settings, new Set([intro?.key ?? '']))).toBeUndefined();
    // The credits with a next episode: that one at once.
    expect(autoSkip(parts, 1301, 1420, true, settings, new Set())).toMatchObject({
      kind: 'credits',
      next: true,
    });
    expect(autoSkip(parts, 1390, 1420, true, settings, new Set())).toBeUndefined();
    expect(autoSkip(parts, 41, 1420, true, undefined, new Set())).toBeUndefined();
  });
});
