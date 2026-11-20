// A browse page on the TV (Home, Ontdekken), as on Netflix: the header shows
// the title that has the focus, the rows sit below it. The focused row is
// always at the same height, just under the header; the rows above it slide
// out of sight. A page can start with a "top" (the billboard with its
// buttons) that the rows make room for.
//
// The page doesn't scroll: the rows move (translateY). The remote's focus
// search works on where views are laid out, not where they are drawn, so
// "up" and "down" still go to the row above and below.
//
// The focused row is kept by its key, not its place: a row that comes or goes
// above it after a refetch ("Verder kijken" after watching) doesn't move the
// page to another row.
//
// The top and every row are a TvSection: up and down go to the line above and
// below, whatever Android's search would find (see stack.tsx).

import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import { TvSection, TvStack } from './stack';
import { TV_GUTTER } from './ui';

export interface BrowseRow {
  key: string;
  render: (row: { hidden: boolean; onFocus: () => void }) => ReactNode;
}

const MOVE = { duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true };

const Slot = memo(function Slot({
  render,
  hidden,
  onFocus,
}: {
  render: BrowseRow['render'];
  hidden: boolean;
  onFocus: () => void;
}) {
  return <>{render({ hidden, onFocus })}</>;
});

const TopSlot = memo(function TopSlot({
  render,
  onFocus,
}: {
  render: (onFocus: () => void) => ReactNode;
  onFocus: () => void;
}) {
  return <>{render(onFocus)}</>;
});

export function TvBrowse({
  background,
  header,
  top,
  rows,
}: {
  /** Behind everything: the backdrop of the focused title. */
  background?: ReactNode;
  /** Above the rows while a row has the focus: the focused title. */
  header?: ReactNode;
  /** The start of the page, while it has the focus (the billboard). Its buttons call onFocus. */
  top?: (onFocus: () => void) => ReactNode;
  rows: BrowseRow[];
}) {
  const { height } = useWindowDimensions();
  // Where the focused row's title is; with a top, the first row first peeks in lower.
  const anchor = Math.round(height * 0.47);
  const rest = top ? Math.round(height * 0.74) : anchor;
  const [y] = useState(() => new Animated.Value(0));
  const [atTop] = useState(() => new Animated.Value(top ? 1 : 0));
  /** Where each row is laid out, by key. */
  const offsets = useRef(new Map<string, number>());
  /** The focused row's key; undefined: the top (or nothing yet). */
  const initial = top ? undefined : rows[0]?.key;
  const current = useRef<string | undefined>(initial);
  const [focusedKey, setFocusedKey] = useState(initial);

  const targetOf = useCallback(
    (key: string | undefined) =>
      key === undefined ? 0 : anchor - rest - (offsets.current.get(key) ?? 0),
    [anchor, rest],
  );
  const go = useCallback(
    (key: string | undefined) => {
      if (key === current.current) return;
      current.current = key;
      setFocusedKey(key);
      const offset = targetOf(key);
      Animated.parallel([
        Animated.timing(y, { ...MOVE, toValue: offset }),
        Animated.timing(atTop, { ...MOVE, duration: 220, toValue: key === undefined ? 1 : 0 }),
      ]).start();
    },
    [atTop, targetOf, y],
  );
  const focusTop = useCallback(() => go(undefined), [go]);
  const handlers = useMemo(
    () => new Map(rows.map((row) => [row.key, () => go(row.key)])),
    [rows, go],
  );
  // The focused row is gone (a refetch): to the top, or the first row.
  useEffect(() => {
    const key = current.current;
    if (key !== undefined && !rows.some((row) => row.key === key)) {
      go(top ? undefined : rows[0]?.key);
    }
  }, [rows, go, top]);
  const focusedIndex = rows.findIndex((row) => row.key === focusedKey);

  return (
    <TvStack>
      <View style={styles.page}>
        {background}
        {header && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.header,
              {
                height: anchor - 24,
                opacity: atTop.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              },
            ]}
          >
            {header}
          </Animated.View>
        )}
        {top && (
          <Animated.View style={[styles.top, { height: rest - 12, opacity: atTop }]}>
            <TvSection order={-1}>
              <TopSlot render={top} onFocus={focusTop} />
            </TvSection>
          </Animated.View>
        )}
        <Animated.View style={[styles.rows, { top: rest, transform: [{ translateY: y }] }]}>
          {rows.map((row, index) => (
            <View
              key={row.key}
              onLayout={(event) => {
                const at = event.nativeEvent.layout.y;
                if (offsets.current.get(row.key) === at) return;
                offsets.current.set(row.key, at);
                // A row above the focused one came, went or changed height: keep
                // the focused row where it was on screen.
                if (current.current !== undefined) {
                  Animated.timing(y, { ...MOVE, toValue: targetOf(current.current) }).start();
                }
              }}
            >
              <TvSection order={index}>
                <Slot
                  render={row.render}
                  hidden={focusedIndex >= 0 && index < focusedIndex}
                  onFocus={handlers.get(row.key) ?? focusTop}
                />
              </TvSection>
            </View>
          ))}
        </Animated.View>
      </View>
    </TvStack>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, overflow: 'hidden' },
  header: {
    position: 'absolute',
    top: 0,
    left: TV_GUTTER,
    width: '56%',
    justifyContent: 'flex-end',
    paddingBottom: 4,
  },
  top: {
    position: 'absolute',
    top: 0,
    left: TV_GUTTER,
    width: '56%',
    justifyContent: 'flex-end',
  },
  rows: { position: 'absolute', left: 0, right: 0, gap: 10 },
});
