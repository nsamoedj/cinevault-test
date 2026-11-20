// Arrow-key navigation for TV remotes (and keyboards): an arrow moves the
// focus to the nearest control in that direction, like on a smart TV app.
// The Back key of a remote goes back a page.

import { useEffect } from 'react';
import { isTv } from './device.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Direction = 'up' | 'down' | 'left' | 'right';

const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** Back on remotes: LG webOS sends 461, Samsung Tizen 10009. */
export function isBackKey(event: KeyboardEvent): boolean {
  return (
    event.key === 'GoBack' ||
    event.key === 'BrowserBack' ||
    event.keyCode === 461 ||
    event.keyCode === 10009
  );
}

function visible(element: HTMLElement): boolean {
  if (element.closest('[inert], [aria-hidden="true"]')) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.opacity !== '0';
}

/** Arrow keys that a focused control needs itself. */
function keepsArrows(element: Element, direction: Direction): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    if (type === 'range') return direction === 'left' || direction === 'right';
    if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') {
      return type === 'radio';
    }
    // Text fields: left and right move the cursor, up and down leave the field.
    return direction === 'left' || direction === 'right';
  }
  return false;
}

/** The candidate nearest to `from` in `direction`, or undefined. */
export function nearest(
  from: DOMRect,
  direction: Direction,
  candidates: { element: HTMLElement; rect: DOMRect }[],
): HTMLElement | undefined {
  let best: { element: HTMLElement; score: number } | undefined;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  for (const { element, rect } of candidates) {
    let main: number;
    let cross: number;
    switch (direction) {
      case 'right':
        main = rect.left - from.right;
        cross = overlap(from.top, from.bottom, rect.top, rect.bottom)
          ? 0
          : Math.abs(rect.top + rect.height / 2 - cy);
        break;
      case 'left':
        main = from.left - rect.right;
        cross = overlap(from.top, from.bottom, rect.top, rect.bottom)
          ? 0
          : Math.abs(rect.top + rect.height / 2 - cy);
        break;
      case 'down':
        main = rect.top - from.bottom;
        cross = overlap(from.left, from.right, rect.left, rect.right)
          ? 0
          : Math.abs(rect.left + rect.width / 2 - cx);
        break;
      case 'up':
        main = from.top - rect.bottom;
        cross = overlap(from.left, from.right, rect.left, rect.right)
          ? 0
          : Math.abs(rect.left + rect.width / 2 - cx);
        break;
    }
    // A little overlap is fine (cards that scale on focus).
    if (main < -8) continue;
    const score = Math.max(0, main) + cross * 2;
    if (!best || score < best.score) best = { element, score };
  }
  return best?.element;
}

function overlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(a2, b2) - Math.max(a1, b1) > 4;
}

function move(direction: Direction): boolean {
  const active = document.activeElement as HTMLElement | null;
  // Menus and sheets keep the focus inside.
  const scope =
    (active?.closest('[data-focus-scope]') as HTMLElement | null) ??
    (document.querySelector('[data-focus-scope="modal"]') as HTMLElement | null) ??
    document.body;
  const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element !== active && element.tabIndex >= 0 && visible(element),
  );
  if (all.length === 0) return false;
  if (!active || active === document.body || !scope.contains(active)) {
    const first =
      scope.querySelector<HTMLElement>('[data-autofocus]') ??
      all.find((e) => e.closest('main')) ??
      all[0];
    first?.focus();
    return Boolean(first);
  }
  const target = nearest(
    active.getBoundingClientRect(),
    direction,
    all.map((element) => ({ element, rect: element.getBoundingClientRect() })),
  );
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  return true;
}

/** Installs the arrow-key navigation and the Back key for the whole app. */
export function useSpatialNavigation(onBack: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isBackKey(event)) {
        event.preventDefault();
        onBack();
        return;
      }
      const direction = DIRECTIONS[event.key];
      if (!direction) return;
      const active = document.activeElement;
      // On a computer the arrows scroll the page until a control has the focus.
      if (!isTv() && (!active || active === document.body)) return;
      if (active && keepsArrows(active, direction)) return;
      if (move(direction)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);
}
