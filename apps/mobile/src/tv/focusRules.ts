// When the TV app moves the focus itself (focus.tsx, TvRow). No React Native
// here, so the tests can load it.

/** A focus change this soon after a key press is the viewer's move. */
export const KEY_MS = 700;

export interface LastKey {
  key: string;
  at: number;
}

const REMOTE_KEYS = new Set(['up', 'down', 'left', 'right', 'select', 'back']);

/**
 * A press or release of a remote's button. React Native also reports each
 * focus change on the same "onHWKeyEvent" channel ("focus" and "blur", with
 * eventKeyAction -1; ReactAndroidHWInputDeviceHelper.onFocusChanged): those
 * are no key. Counting them made every focus change look like a key press
 * that was neither "up" nor "down" (eigenaar 2026-11-10: "1x omhoog gaat de
 * focus helemaal terug naar de top").
 */
export function remoteKeyOf(event: {
  eventType?: string;
  eventKeyAction?: number;
}): string | undefined {
  if (event.eventKeyAction !== 0 && event.eventKeyAction !== 1) return undefined;
  return event.eventType && REMOTE_KEYS.has(event.eventType) ? event.eventType : undefined;
}

/** The last key was one of `keys`, just now. */
export function keyedRecently(
  last: LastKey | undefined,
  keys: readonly string[],
  now: number,
): boolean {
  return last !== undefined && now - last.at < KEY_MS && keys.includes(last.key);
}

/**
 * No key press and no focus call of the app explains a focus change: Android
 * moved it by itself (the focused view went away).
 */
export function unexplainedFocus(
  last: LastKey | undefined,
  ownFocusUntil: number,
  now: number,
): boolean {
  if (now < ownFocusUntil) return false;
  return last === undefined || now - last.at >= KEY_MS;
}

/**
 * The card a row should have when a card of it got the focus: the one that
 * is drawn right under (or above) where the focus was, when the viewer came
 * in with up or down; else the one that got it.
 *
 * Rows slide (translateX) so that the focused card is at their left edge, and
 * Android's focus search looks at where cards are laid out, not where they
 * are drawn: it lands on the card at the same place in the row's layout. A
 * short row doesn't slide, and a long one stops sliding at its end, so the
 * focused card isn't always at the left edge: going to the card the row had
 * last (as before 2026-10-28) then jumped sideways ("down jumps one to the
 * right", eigenaar 2026-10-28). Positions are relative to the rows' viewport,
 * which all rows of a screen share.
 */
export function rowFocusTarget(options: {
  /** The card Android gave the focus. */
  index: number;
  length: number;
  /** The focus came from outside the row, with up or down. */
  enteredVertically: boolean;
  /** Card width plus gap. */
  step: number;
  itemWidth: number;
  /** How far the row is slid to the left now. */
  shift: number;
  /**
   * The middle of the card the focus came from, as drawn; undefined when it
   * came from outside a row (a button): that isn't slid, so it is where
   * Android's pick is laid out.
   */
  from?: number;
}): number {
  const { index, length, step, itemWidth, shift } = options;
  if (!options.enteredVertically || length === 0 || step <= 0) return index;
  const center = options.from ?? index * step + itemWidth / 2;
  const target = Math.round((center + shift - itemWidth / 2) / step);
  return Math.min(Math.max(0, target), length - 1);
}

/** Where up or down goes: a view's tag, or 'self' (stay: nothing above or below). */
export type FocusTarget = number | 'self';

export interface SectionEntry {
  /** Top to bottom on the page. */
  order: number;
  /** The view up or down lands on in this section. */
  tag: number;
}

/**
 * Up and down from a section of a TV page (a line of buttons or chips, a row
 * of cards): to the section above and below, or nowhere at the page's top and
 * bottom. Android's own search would pick what is nearest in the layout:
 * from far right in a long row, which slides, that skipped a short row below
 * or went into the menu ("de focus springt naar een onbedoelde sectie",
 * eigenaar 2026-11-10).
 */
export function sectionNeighbors(
  entries: Record<string, SectionEntry>,
  id: string,
): { up: FocusTarget; down: FocusTarget; upOrder?: number; downOrder?: number } | undefined {
  if (!entries[id]) return undefined;
  const sorted = Object.entries(entries).sort(
    ([a, x], [b, y]) => x.order - y.order || (a < b ? -1 : a > b ? 1 : 0),
  );
  const at = sorted.findIndex(([key]) => key === id);
  const above = sorted[at - 1]?.[1];
  const below = sorted[at + 1]?.[1];
  return {
    up: above?.tag ?? 'self',
    down: below?.tag ?? 'self',
    ...(above && { upOrder: above.order }),
    ...(below && { downOrder: below.order }),
  };
}

/** Where the focus was: its line on the page, and the lines above and below it. */
export interface FocusPlace {
  stack: object;
  order: number;
  upOrder?: number;
  downOrder?: number;
  upTag?: number;
  downTag?: number;
}

/**
 * After "up" or "down" the focus belongs on the line right above or below.
 * Landed elsewhere on the same page (Android moved it itself, for example to
 * the billboard's buttons, which stay focusable while out of sight): the view
 * to send it to instead; undefined when it is where it belongs.
 */
export function wrongLine(
  key: string | undefined,
  from: FocusPlace | undefined,
  to: { stack: object; order: number } | undefined,
): number | undefined {
  if (!from || !to || from.stack !== to.stack || to.order === from.order) return undefined;
  if (key === 'up') return to.order === from.upOrder ? undefined : from.upTag;
  if (key === 'down') return to.order === from.downOrder ? undefined : from.downTag;
  return undefined;
}
