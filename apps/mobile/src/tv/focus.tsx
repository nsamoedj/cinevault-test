// Focus on a TV: the remote's D-pad moves the focus from one focusable view to
// the nearest one in that direction (Android does that), and the centre
// button presses it. These make the focus visible, put it where a screen
// starts, and bring it back to where it was when the viewer comes back.
//
// Android also moves the focus by itself: when the focused view goes away (a
// row that reorders after a refetch, a button that is replaced), it gives the
// focus to the first focusable view, usually the menu. A focus change that no
// key press explains is such a jump; the focus then goes back to where it was
// on the screen (`FocusMemory`), so the page doesn't jump.

import { useFocusEffect } from 'expo-router';
import {
  createContext,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  DeviceEventEmitter,
  Easing,
  findNodeHandle,
  type HostInstance,
  Platform,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { focusView } from '../../modules/cinevault-media';
import { colors } from '../theme';
import {
  type FocusPlace,
  type FocusTarget,
  keyedRecently as recentKey,
  type LastKey,
  remoteKeyOf,
  unexplainedFocus as unexplained,
  wrongLine,
} from './focusRules';
import { NeighborContext, SectionContext } from './stack';

/** A TV (Android TV, Google TV): the app shows its TV screens. */
export const isTV = Platform.isTV;

/** How a focused card or button stands out: a brass ring, a little larger. */
export const focusRing: ViewStyle = {
  borderColor: colors.brass,
  transform: [{ scale: 1.06 }],
};

/** For a TvPressable that shows its focus itself (with FocusScale). */
export const noFocusStyle: ViewStyle = {};

/** Grows what has the focus, smoothly, as Netflix and Plex do on a TV. */
export function FocusScale({
  focused,
  scale = 1.08,
  style,
  children,
}: {
  focused: boolean;
  scale?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [value] = useState(() => new Animated.Value(focused ? scale : 1));
  useEffect(() => {
    Animated.timing(value, {
      toValue: focused ? scale : 1,
      duration: 170,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [focused, scale, value]);
  return (
    <Animated.View style={[style, { transform: [{ scale: value }] }]}>{children}</Animated.View>
  );
}

type View = HostInstance;

function tagOf(view: View | null): number | null {
  return view ? (findNodeHandle(view) ?? null) : null;
}

// The remote's last key: a focus change soon after one is the viewer's move.
let lastKey: LastKey | undefined;
/** Until when a focus change is the app's own (focusLater, a redirect). */
let ownFocusUntil = 0;

if (isTV) {
  DeviceEventEmitter.addListener(
    'onHWKeyEvent',
    (event: { eventType?: string; eventKeyAction?: number }) => {
      // Down (0) and up (1): a held button keeps moving the focus. Not the
      // "focus" and "blur" React Native sends on the same channel.
      const key = remoteKeyOf(event);
      if (key) lastKey = { key, at: Date.now() };
    },
  );
}

/** The last key was one of these, just now. */
export function keyedRecently(keys: readonly string[]): boolean {
  return recentKey(lastKey, keys, Date.now());
}

/** No key and no focus call of the app explains this focus change: Android moved it. */
function unexplainedFocus(): boolean {
  return isTV && unexplained(lastKey, ownFocusUntil, Date.now());
}

/** Gives a view the focus now; false when it isn't there (any more). */
export function focusNow(view: View | null): Promise<boolean> {
  return focusTag(tagOf(view));
}

function focusTag(tag: number | null): Promise<boolean> {
  ownFocusUntil = Date.now() + 400;
  if (tag !== null) ownTarget = { tag, until: Date.now() + 1000 };
  return focusView(tag);
}

/** The view the app just asked to focus: its focus is the app's own, not Android's pick. */
let ownTarget: { tag: number; until: number } | undefined;

/** This view's focus is the one the app asked for (and no longer expected). */
function askedFor(tag: number | null): boolean {
  const target = ownTarget;
  if (!target || tag === null || target.tag !== tag || Date.now() > target.until) return false;
  ownTarget = undefined;
  return true;
}

/** The line of a TvStack page the focus is on (see wrongLine). */
let focusPlace: FocusPlace | undefined;

/** Focuses a view once it is on screen; the native view may not be attached at once. */
export function focusLater(view: View | null, delay = 60) {
  ownFocusUntil = Date.now() + delay + 600;
  setTimeout(() => {
    void focusNow(view).then((done) => {
      if (!done) setTimeout(() => void focusNow(view), 250);
    });
  }, delay);
}

/** The views of a screen that had the focus, newest first: to go back to one that is still there. */
const HISTORY = 8;

interface Memory {
  /** A view of the screen got the focus. */
  remember: (view: View | null) => void;
  /** The view that had it last. */
  last: () => View | null;
  /** Where the screen starts (an autoFocus view): when the last one is gone. */
  start: (view: View | null) => void;
}

// The last focused view of a screen, to go back to when the screen is shown again.
const MemoryContext = createContext<Memory | undefined>(undefined);

/** The shown screen's way back to its focus. */
let activeRestore: (() => Promise<boolean>) | undefined;

/** Puts the focus back where it was on the shown screen (or where it starts); false without. */
export function restoreFocus(): Promise<boolean> {
  return activeRestore ? activeRestore() : Promise.resolve(false);
}

/** Wraps a TV screen: when the viewer comes back to it, the focus returns to where it was. */
export function FocusMemory({ children }: { children: ReactNode }) {
  const last = useRef<View | null>(null);
  const first = useRef<View | null>(null);
  const history = useRef<View[]>([]);
  const [memory] = useState<Memory>(() => ({
    remember: (view) => {
      last.current = view;
      if (!view) return;
      history.current = [view, ...history.current.filter((v) => v !== view)].slice(0, HISTORY);
    },
    last: () => last.current,
    start: (view) => {
      first.current = view;
    },
  }));
  // The last focused view; gone (a button replaced by a status, a row that
  // changed): the one before it that is still there, else where the screen
  // starts. Before, a gone view and a gone start left the focus where Android
  // put it: often the menu.
  const restore = useCallback(async () => {
    const tried = new Set<View>();
    for (const view of [last.current, ...history.current, first.current]) {
      if (!view || tried.has(view)) continue;
      tried.add(view);
      if (await focusNow(view)) return true;
    }
    return false;
  }, []);
  useFocusEffect(
    useCallback(() => {
      activeRestore = restore;
      if (last.current) {
        ownFocusUntil = Date.now() + 800;
        setTimeout(() => void restore(), 120);
      }
      return () => {
        if (activeRestore === restore) activeRestore = undefined;
      };
    }, [restore]),
  );
  return <MemoryContext.Provider value={memory}>{children}</MemoryContext.Provider>;
}

/**
 * A row's cards: which card is where, so that the row can take the focus at
 * its own card (see TvRow) rather than where Android's focus search lands.
 */
export interface RowFocus {
  id: string;
  register: (index: number, view: View | null) => void;
}
export const RowContext = createContext<
  { row: RowFocus; index: number; last: boolean } | undefined
>(undefined);

/** The row of the focused card, and of the one before it. */
let focusedRow: string | undefined;
/** The middle of the focused card as drawn (TvRow); undefined when the focus isn't in a row. */
let rowCardCenter: number | undefined;

/** Where the focused row card is drawn; undefined outside rows. */
export function focusedCardCenter(): number | undefined {
  return rowCardCenter;
}

/** A row's card got the focus and is drawn here. */
export function setFocusedCardCenter(center: number): void {
  rowCardCenter = center;
}
let previousRow: string | undefined;
/** The focused view is on a screen (not in the menu). */
let focusInScreen = false;

/** The focus just came into this row from somewhere else. */
export function enteredRow(id: string): boolean {
  return previousRow !== id;
}

export type FocusState = { focused: boolean; pressed: boolean };

export type TvPressableProps = Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle> | ((state: FocusState) => StyleProp<ViewStyle>);
  /** Added while focused; the ring by default. */
  focusStyle?: StyleProp<ViewStyle>;
  children?: ReactNode | ((state: FocusState) => ReactNode);
  /** Takes the focus when it appears (the first thing on a screen). */
  autoFocus?: boolean;
  /**
   * The last of a line of buttons or chips: "right" stays here. Android would
   * look for anything laid out to the right, also a card in a row below.
   */
  lastInLine?: boolean;
  ref?: Ref<View | null>;
};

/** A Pressable that shows when the remote's focus is on it. */
export function TvPressable({
  style,
  focusStyle = focusRing,
  children,
  autoFocus,
  lastInLine,
  onFocus,
  onBlur,
  ref,
  ...props
}: TvPressableProps) {
  const [focused, setFocused] = useState(false);
  const view = useRef<View | null>(null);
  const memory = useContext(MemoryContext);
  const card = useContext(RowContext);
  const section = useContext(SectionContext);
  const neighbors = useContext(NeighborContext);
  useImperativeHandle(ref, () => view.current as View, []);

  // Its own tag, for "stay here" (the end of a line, the top or bottom of a page).
  const stayRight = Boolean(lastInLine || card?.last);
  const needsOwn = stayRight || neighbors?.up === 'self' || neighbors?.down === 'self';
  const [own, setOwn] = useState<number | undefined>();
  useEffect(() => {
    if (needsOwn) setOwn(tagOf(view.current) ?? undefined);
  }, [needsOwn]);
  useEffect(() => {
    const current = view.current;
    if (!section || !current) return;
    section.add(current);
    return () => section.remove(current);
  }, [section]);
  const target = (to: FocusTarget | undefined) => (to === 'self' ? own : to);
  const up = target(neighbors?.up);
  const down = target(neighbors?.down);
  const next = {
    ...(up !== undefined && { nextFocusUp: up }),
    ...(down !== undefined && { nextFocusDown: down }),
    ...(stayRight && own !== undefined && { nextFocusRight: own }),
  };

  useEffect(() => {
    if (!autoFocus) return;
    memory?.start(view.current);
    focusLater(view.current);
  }, [autoFocus, memory]);
  useEffect(() => {
    if (!card) return;
    card.row.register(card.index, view.current);
    return () => card.row.register(card.index, null);
  }, [card]);

  return (
    <Pressable
      ref={view}
      focusable
      {...next}
      {...props}
      onFocus={(event) => {
        setFocused(true);
        const accept = () => {
          focusPlace = neighbors && {
            stack: neighbors.stack,
            order: neighbors.order,
            ...(neighbors.upOrder !== undefined && { upOrder: neighbors.upOrder }),
            ...(neighbors.downOrder !== undefined && { downOrder: neighbors.downOrder }),
            ...(typeof up === 'number' && { upTag: up }),
            ...(typeof down === 'number' && { downTag: down }),
          };
          previousRow = focusedRow;
          focusedRow = card?.row.id;
          // Outside a row: the next row goes by where Android lands (see TvRow).
          if (!card) rowCardCenter = undefined;
          focusInScreen = Boolean(memory);
          memory?.remember(view.current);
          onFocus?.(event);
        };
        // Android moved the focus here by itself (the focused view went away),
        // or "right" out of the menu landed where the search found something
        // (where the page is laid out, not where it is drawn): back to where
        // it was on the screen instead.
        const fromMenu =
          memory !== undefined &&
          !focusInScreen &&
          keyedRecently(['right']) &&
          Date.now() >= ownFocusUntil;
        const elsewhere = memory?.last() !== view.current;
        // "Up" or "down" landed on a line that isn't the one above or below
        // (Android's own pick): to that line instead.
        // Only the view the app asked for is exempt: Android can still pick a
        // wrong line right after one of the app's own moves (a second "up").
        const vertical = keyedRecently(['up'])
          ? 'up'
          : keyedRecently(['down'])
            ? 'down'
            : undefined;
        const instead = askedFor(tagOf(view.current))
          ? undefined
          : wrongLine(vertical, focusPlace, neighbors);
        if (instead !== undefined) {
          void focusTag(instead).then((moved) => {
            if (!moved) accept();
          });
          return;
        }
        if (elsewhere && (unexplainedFocus() || fromMenu)) {
          void restoreFocus().then((restored) => {
            if (!restored) accept();
          });
          return;
        }
        accept();
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={({ pressed }) => [
        typeof style === 'function' ? style({ focused, pressed }) : style,
        focused && focusStyle,
      ]}
    >
      {({ pressed }) =>
        typeof children === 'function' ? children({ focused, pressed }) : children
      }
    </Pressable>
  );
}
