// Which notifications from the server the phone shows itself. Pure, for tests.

import type { NotificationDto } from '@cinevault/shared';

/** Older ones are not shown any more (the phone was off for days). */
const MAX_AGE_MS = 2 * 86_400_000;
/** More than this at once become one summary. */
const MAX_SINGLE = 4;
/** How many shown ids the phone remembers. */
const REMEMBER = 200;

export interface PickResult {
  show: NotificationDto[];
  /** More than MAX_SINGLE new ones: one notification saying how many, instead of each. */
  summary?: { count: number; latest: NotificationDto };
  /** The ids to remember as seen. */
  seen: number[];
}

/**
 * `seen` undefined: the first time after logging in, or after switching
 * notifications on. Everything that is there is then seen, so nothing old
 * pops up (not even "new login", which is about this very phone).
 */
export function pickNew(
  items: NotificationDto[],
  seen: number[] | undefined,
  now = Date.now(),
): PickResult {
  const ids = items.map((n) => n.id);
  if (!seen) return { show: [], seen: ids.slice(0, REMEMBER) };
  const known = new Set(seen);
  const fresh = items
    .filter((n) => !known.has(n.id) && !n.read)
    .filter((n) => now - Date.parse(n.createdAt) <= MAX_AGE_MS)
    .sort((a, b) => a.id - b.id);
  const remember = [...new Set([...ids, ...seen])].sort((a, b) => b - a).slice(0, REMEMBER);
  const latest = fresh.at(-1);
  if (fresh.length > MAX_SINGLE && latest) {
    return { show: [], summary: { count: fresh.length, latest }, seen: remember };
  }
  return { show: fresh, seen: remember };
}
