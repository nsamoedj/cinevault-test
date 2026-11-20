// Android Automotive OS (a car with Google built-in, such as a Polestar or a
// Volvo): the app shows its phone and tablet screens, without Chromecast or
// picture-in-picture, and video only plays while the car is parked. While it
// drives, the system covers the app and the player pauses; it does not start
// again by itself.

import { useSyncExternalStore } from 'react';
import { PixelRatio } from 'react-native';
import {
  drivingRestricted,
  isAutomotive,
  onDrivingRestrictionChange,
} from '../modules/cinevault-media';

export const isCar = isAutomotive();

/**
 * How much bigger everything is drawn in a car. The layout is made for a
 * screen drawn at 1.4× (like a tablet); the Polestar 4 draws its 1920×1200
 * screen at about 1× (the owner's photo, 2026-11-03), which made text and
 * buttons a third smaller than intended. `carScale.ts` applies it to every
 * StyleSheet; `px` is for sizes in code. 1 outside a car.
 */
export const carScale = isCar ? Math.min(1.6, Math.max(1, 1.4 / PixelRatio.get())) : 1;

/** A size in the app's units, scaled for the car (unchanged elsewhere). */
export function px(size: number): number {
  return size * carScale;
}

// One listener for the whole app, while something watches.
let restricted = isCar && drivingRestricted();
const watchers = new Set<() => void>();
let subscription: { remove(): void } | undefined;

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  if (isCar && !subscription) {
    subscription = onDrivingRestrictionChange((value) => {
      restricted = value;
      for (const notify of watchers) notify();
    });
    // It may have changed while nobody listened.
    restricted = drivingRestricted();
  }
  return () => {
    watchers.delete(watcher);
    if (watchers.size === 0) {
      subscription?.remove();
      subscription = undefined;
    }
  };
}

/** True while the car drives (always false outside a car). */
export function useDrivingRestricted(): boolean {
  return useSyncExternalStore(subscribe, () => restricted);
}

/** "deze auto" or "deze telefoon", for texts about this device. */
export const thisDevice = isCar ? 'deze auto' : 'deze telefoon';

/**
 * In a car the screens get a wider layout: a menu on the left (the bottom of
 * the screen holds the car's own bar), a lower billboard, and buttons that
 * don't stretch across a 15-inch screen. The Polestar 4 is 1920×1200, landscape.
 */
export const carLayout = {
  /** Width of the menu on the left. */
  rail: 124,
  /** Text, buttons and panels stay within this width. */
  column: 760,
  /** Height of the billboard and the backdrop of a title, as a share of the screen. */
  hero: 0.6,
  /** Minimum height of a button: bigger touch targets, for a screen at arm's length. */
  button: 56,
} as const;
