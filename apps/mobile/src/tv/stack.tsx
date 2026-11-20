// The lines of a TV page, top to bottom: a line of buttons, of chips, a row of
// cards. Up and down go from one line to the one above or below it, and stay
// where they are at the page's top and bottom.
//
// Android's own focus search picks what is nearest in the layout. Rows slide
// (translateX, translateY), and the search doesn't see that: from far right
// in a long row, "down" skipped a short row or went into the menu, and "up"
// from the top buttons went into the menu (eigenaar 2026-11-10). Every
// TvPressable in a TvSection gets nextFocusUp and nextFocusDown to the line
// above and below: its first view, and a TvRow then moves the focus to the
// card drawn right under where it was (rowFocusTarget).

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { findNodeHandle, type HostInstance } from 'react-native';
import { type FocusTarget, type SectionEntry, sectionNeighbors } from './focusRules';

export interface Neighbors {
  /** The page (TvStack) and this line's place on it. */
  stack: object;
  order: number;
  up?: FocusTarget;
  down?: FocusTarget;
  upOrder?: number;
  downOrder?: number;
}

/** Where up and down go from the views in here; none outside a TvStack. */
export const NeighborContext = createContext<Neighbors | undefined>(undefined);

interface Section {
  add: (view: HostInstance) => void;
  remove: (view: HostInstance) => void;
}

/** The line a TvPressable belongs to; it adds itself. */
export const SectionContext = createContext<Section | undefined>(undefined);

interface Stack {
  setEntry: (id: string, entry: SectionEntry | undefined) => void;
}

const StackContext = createContext<Stack | undefined>(undefined);
const EntriesContext = createContext<Record<string, SectionEntry>>({});

/** A page of lines (TvSection) with up and down from one to the next. */
export function TvStack({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, SectionEntry>>({});
  const stack = useMemo<Stack>(
    () => ({
      setEntry: (id, entry) =>
        setEntries((current) => {
          const old = current[id];
          if (!entry) {
            if (!old) return current;
            const rest = { ...current };
            delete rest[id];
            return rest;
          }
          if (old && old.order === entry.order && old.tag === entry.tag) return current;
          return { ...current, [id]: entry };
        }),
    }),
    [],
  );
  return (
    <StackContext.Provider value={stack}>
      <EntriesContext.Provider value={entries}>{children}</EntriesContext.Provider>
    </StackContext.Provider>
  );
}

/**
 * One line of a TvStack; `order` puts it in its place, top to bottom. A line
 * that wraps (chips on two lines) keeps Android's own up and down inside it:
 * `wraps`. Up or down from another line still lands on its first view.
 */
export function TvSection({
  order,
  wraps,
  children,
}: {
  order: number;
  wraps?: boolean;
  children: ReactNode;
}) {
  const stack = useContext(StackContext);
  const entries = useContext(EntriesContext);
  const id = useId();
  const views = useRef<HostInstance[]>([]);
  const orderRef = useRef(order);
  const report = useCallback(() => {
    const first = views.current[0];
    const tag = first ? findNodeHandle(first) : null;
    stack?.setEntry(id, tag ? { order: orderRef.current, tag } : undefined);
  }, [id, stack]);
  const section = useMemo<Section>(
    () => ({
      add: (view) => {
        if (views.current.includes(view)) return;
        views.current.push(view);
        report();
      },
      remove: (view) => {
        views.current = views.current.filter((v) => v !== view);
        report();
      },
    }),
    [report],
  );
  useEffect(() => {
    orderRef.current = order;
    report();
  }, [order, report]);
  useEffect(() => () => stack?.setEntry(id, undefined), [id, stack]);
  const around = sectionNeighbors(entries, id);
  // A line that wraps keeps Android's own up and down inside it, but its place
  // still counts (see wrongLine).
  const neighbors = useMemo<Neighbors | undefined>(
    () =>
      stack
        ? {
            stack,
            order,
            ...(around && !wraps && { up: around.up, down: around.down }),
            ...(around?.upOrder !== undefined && { upOrder: around.upOrder }),
            ...(around?.downOrder !== undefined && { downOrder: around.downOrder }),
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stack, order, around?.up, around?.down, around?.upOrder, around?.downOrder, wraps],
  );
  return (
    <SectionContext.Provider value={section}>
      <NeighborContext.Provider value={neighbors}>{children}</NeighborContext.Provider>
    </SectionContext.Provider>
  );
}
