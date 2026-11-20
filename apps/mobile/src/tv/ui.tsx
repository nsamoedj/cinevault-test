// Building blocks of the TV screens, sized for a TV seen from the couch (a
// 1080p TV is 960 × 540 dp): buttons, cards that grow smoothly when they get
// the remote's focus, and rows that keep the focused card at the left edge,
// as Netflix and Plex do.

import {
  airDateLabel,
  canRequestPart,
  collectionLabel,
  type CollectionPart,
  type CollectionSummary,
  type ContinueEntry,
  isRecent,
  type ItemSummary,
  missingPartLabel,
  type NewEpisodes,
  newEpisodesLabel,
  type UpcomingEpisode,
} from '@cinevault/shared';
import { router } from 'expo-router';
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  type HostInstance,
  StyleSheet,
  Text,
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { Icon, type IconName } from '../components/Icon';
import { ProgressBar, ServerImage, WatchedBadge } from '../components/ui';
import { clockLabel } from '../format';
import { colors, radius } from '../theme';
import {
  enteredRow,
  FocusScale,
  focusedCardCenter,
  focusNow,
  keyedRecently,
  noFocusStyle,
  RowContext,
  type RowFocus,
  setFocusedCardCenter,
  TvPressable,
  type TvPressableProps,
} from './focus';
import { rowFocusTarget } from './focusRules';

/** The side menu's width when closed (icons only). */
export const NAV_WIDTH = 72;
/** The margin TVs may cut off at the edges (overscan): 5% of 960 dp. */
export const TV_GUTTER = 48;
/** Between the cards of a row. */
export const CARD_GAP = 14;

/** Card widths for the content area next to the menu. */
export function useTvSizes() {
  const { width, height } = useWindowDimensions();
  const inner = width - NAV_WIDTH - TV_GUTTER * 2;
  return {
    /** 6.5 posters in view: the next one peeks in. */
    poster: Math.round((inner - CARD_GAP * 5.5) / 6.5),
    /** 3.6 wide cards in view. */
    landscape: Math.round((inner - CARD_GAP * 2.6) / 3.6),
    inner,
    width,
    height,
  };
}

export function TvButton({
  label,
  icon,
  onPress,
  autoFocus,
  disabled,
  primary,
  style,
  ref,
  ...props
}: {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** "Afspelen": light even without the focus. */
  primary?: boolean;
  style?: ViewStyle;
} & Pick<
  TvPressableProps,
  'onFocus' | 'onBlur' | 'ref' | 'nextFocusDown' | 'nextFocusUp' | 'focusable' | 'lastInLine'
>) {
  return (
    <TvPressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      autoFocus={autoFocus}
      focusStyle={noFocusStyle}
      style={[disabled && { opacity: 0.45 }, style]}
      {...props}
    >
      {({ focused }) => (
        <FocusScale
          focused={focused}
          scale={1.06}
          style={[styles.button, primary && styles.buttonPrimary, focused && styles.buttonFocused]}
        >
          {icon && (
            <Icon name={icon} size={22} color={focused || primary ? colors.ink : colors.text} />
          )}
          <Text style={[styles.buttonText, (focused || primary) && { color: colors.ink }]}>
            {label}
          </Text>
        </FocusScale>
      )}
    </TvPressable>
  );
}

/** A round button with only an icon; its name shows under it while it has the focus. */
export function TvIconButton({
  label,
  icon,
  onPress,
  onFocus,
  on,
  autoFocus,
  lastInLine,
}: {
  label: string;
  icon: IconName;
  onPress?: () => void;
  onFocus?: () => void;
  /** Mijn lijst, Gezien: brass when on. */
  on?: boolean;
  autoFocus?: boolean;
  lastInLine?: boolean;
}) {
  return (
    <TvPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={onFocus}
      autoFocus={autoFocus}
      lastInLine={lastInLine}
      focusStyle={noFocusStyle}
      style={styles.iconButtonBox}
    >
      {({ focused }) => (
        <>
          <FocusScale
            focused={focused}
            scale={1.1}
            style={[styles.iconButton, focused && styles.buttonFocused]}
          >
            <Icon
              name={icon}
              size={24}
              color={focused ? colors.ink : on ? colors.brass : colors.text}
            />
          </FocusScale>
          <Text style={[styles.iconButtonLabel, !focused && { opacity: 0 }]} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </TvPressable>
  );
}

/** A choice in a row of choices (quality, season). */
export function TvChip({
  label,
  on,
  onPress,
  onFocus,
  autoFocus,
  lastInLine,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  onFocus?: () => void;
  autoFocus?: boolean;
  lastInLine?: boolean;
}) {
  return (
    <TvPressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      onFocus={onFocus}
      autoFocus={autoFocus}
      lastInLine={lastInLine}
      focusStyle={noFocusStyle}
    >
      {({ focused }) => (
        // Chosen: brass text on a faint brass ground; with the focus: dark text on brass.
        <FocusScale
          focused={focused}
          scale={1.06}
          style={[styles.chip, on && styles.chipOn, focused && styles.chipFocused]}
        >
          <Text
            style={[
              styles.chipText,
              on && { color: colors.brass },
              focused && { color: colors.ink },
            ]}
          >
            {label}
          </Text>
        </FocusScale>
      )}
    </TvPressable>
  );
}

/** The picture of a card, with the brass ring and a little shadow when focused. */
export function CardFrame({
  focused,
  width,
  ratio,
  children,
}: {
  focused: boolean;
  width: number;
  /** Height / width: 1.5 for posters, 9/16 for wide cards. */
  ratio: number;
  children: ReactNode;
}) {
  return (
    <FocusScale
      focused={focused}
      style={[
        styles.frame,
        { width, height: Math.round(width * ratio) },
        focused && styles.frameFocused,
      ]}
    >
      {children}
    </FocusScale>
  );
}

function posterShare(item: ItemSummary): number {
  const progress = item.progress;
  if (!progress || progress.watched) return 0;
  return (
    progress.fraction ??
    (progress.totalEpisodes ? (progress.watchedEpisodes ?? 0) / progress.totalEpisodes : 0)
  );
}

export function TvPosterCard({
  item,
  width,
  autoFocus,
  titled,
  onFocus,
  focusable,
}: {
  item: ItemSummary;
  width: number;
  autoFocus?: boolean;
  /** False while a panel over the screen has the focus. */
  focusable?: boolean;
  /** The title under the poster; without, the screen's header shows it. */
  titled?: boolean;
  onFocus?: () => void;
}) {
  const share = posterShare(item);
  return (
    <TvPressable
      accessibilityRole="link"
      accessibilityLabel={`${item.title}${item.year ? `, ${item.year}` : ''}`}
      onPress={() => router.push(`/item/${item.id}`)}
      onFocus={onFocus}
      {...(focusable === false && { focusable })}
      autoFocus={autoFocus}
      focusStyle={noFocusStyle}
      style={{ width }}
    >
      {({ focused }) => (
        <>
          <CardFrame focused={focused} width={width} ratio={1.5}>
            <ServerImage
              path={item.posterUrl}
              style={StyleSheet.absoluteFill as ViewStyle}
              fallback={item.title}
            />
            {item.progress?.watched && <WatchedBadge />}
            {share > 0 && <ProgressBar share={share} style={styles.cardProgress} />}
          </CardFrame>
          {titled && (
            <>
              <Text
                style={[styles.cardTitle, focused && styles.cardTitleFocused]}
                numberOfLines={1}
              >
                {item.title}
              </Text>
              {item.year ? <Text style={styles.cardSub}>{item.year}</Text> : null}
            </>
          )}
        </>
      )}
    </TvPressable>
  );
}

/** A wide card: the picture with its name at the bottom, a flag and progress. */
function WideCard({
  label,
  name,
  sub,
  image,
  fallback,
  flag,
  share,
  width,
  play,
  autoFocus,
  onFocus,
  onPress,
}: {
  label: string;
  name: string;
  sub?: string;
  image: string | undefined;
  fallback: string;
  flag?: string;
  share?: number;
  width: number;
  /** A play symbol while focused: OK plays. */
  play?: boolean;
  autoFocus?: boolean;
  onFocus?: () => void;
  onPress: () => void;
}) {
  return (
    <TvPressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={onFocus}
      autoFocus={autoFocus}
      focusStyle={noFocusStyle}
      style={{ width }}
    >
      {({ focused }) => (
        <CardFrame focused={focused} width={width} ratio={9 / 16}>
          <ServerImage
            path={image}
            style={StyleSheet.absoluteFill as ViewStyle}
            fallback={fallback}
          />
          <View style={styles.wideShade} />
          <View style={styles.wideText}>
            <Text style={styles.wideName} numberOfLines={1}>
              {name}
            </Text>
            {sub ? (
              <Text style={styles.wideSub} numberOfLines={1}>
                {sub}
              </Text>
            ) : null}
          </View>
          {play && focused && (
            <View style={styles.playBubble}>
              <Icon name="play" size={20} color={colors.ink} />
            </View>
          )}
          {flag && (
            <View style={styles.flag}>
              <Text style={styles.flagText}>{flag}</Text>
            </View>
          )}
          {share ? <ProgressBar share={share} style={styles.cardProgress} /> : null}
        </CardFrame>
      )}
    </TvPressable>
  );
}

export function continueLine(entry: ContinueEntry): string {
  const episode = entry.episode;
  if (!episode) return entry.item.year ? String(entry.item.year) : 'Film';
  const code = `S${episode.seasonNumber}:A${episode.episodeNumber}`;
  return episode.title ? `${code} · ${episode.title}` : code;
}

export function TvContinueCard({
  entry,
  width,
  autoFocus,
  onFocus,
}: {
  entry: ContinueEntry;
  width: number;
  autoFocus?: boolean;
  onFocus?: () => void;
}) {
  const share = entry.durationMs && entry.positionMs > 0 ? entry.positionMs / entry.durationMs : 0;
  const left = entry.durationMs ? entry.durationMs - entry.positionMs : undefined;
  const line = continueLine(entry);
  return (
    <WideCard
      label={`${entry.item.title}, ${line}`}
      name={entry.item.title}
      sub={
        entry.kind === 'resume' && left && entry.positionMs > 0
          ? `${line} · nog ${clockLabel(left / 1000)}`
          : line
      }
      image={entry.episode?.stillUrl ?? entry.backdropUrl ?? entry.item.backdropUrl}
      fallback={entry.item.title}
      {...(entry.kind === 'next' && { flag: 'Volgende' })}
      share={share}
      width={width}
      play
      autoFocus={autoFocus}
      onFocus={onFocus}
      onPress={() => router.push(`/play/${entry.fileId}`)}
    />
  );
}

/** "Nieuwe afleveringen": a wide card with the episode; it opens the show. */
export function TvNewEpisodesCard({
  entry,
  width,
  onFocus,
}: {
  entry: NewEpisodes;
  width: number;
  onFocus?: () => void;
}) {
  const sub = newEpisodesLabel(entry);
  return (
    <WideCard
      label={`${entry.item.title}, ${sub}`}
      name={entry.item.title}
      sub={sub}
      image={entry.stillUrl ?? entry.item.backdropUrl ?? entry.item.posterUrl}
      fallback={entry.item.title}
      {...(isRecent(entry.addedAt) && {
        flag: entry.count > 1 ? `${entry.count} nieuw` : 'Nieuw',
      })}
      share={entry.fraction}
      width={width}
      onFocus={onFocus}
      onPress={() => router.push(`/item/${entry.item.id}`)}
    />
  );
}

/** "Binnenkort": a wide card with the day the next episode airs; it opens the show. */
export function TvUpcomingCard({
  entry,
  width,
  onFocus,
}: {
  entry: UpcomingEpisode;
  width: number;
  onFocus?: () => void;
}) {
  const when = airDateLabel(entry.airDate);
  return (
    <WideCard
      label={`${entry.item.title}, ${when}`}
      name={entry.item.title}
      sub={`S${entry.seasonNumber} · A${entry.episodeNumber}${entry.title ? ` · ${entry.title}` : ''}`}
      image={entry.item.backdropUrl ?? entry.item.posterUrl}
      fallback={entry.item.title}
      flag={when}
      width={width}
      onFocus={onFocus}
      onPress={() => router.push(`/item/${entry.item.id}`)}
    />
  );
}

/** A collection ("Harry Potter Collection"): a wide card that opens it. */
export function TvCollectionCard({
  collection,
  width,
  autoFocus,
  onFocus,
}: {
  collection: CollectionSummary;
  width: number;
  autoFocus?: boolean;
  onFocus?: () => void;
}) {
  const sub = collectionLabel(collection);
  return (
    <WideCard
      label={`${collection.name}, ${sub}`}
      name={collection.name}
      sub={sub}
      image={collection.backdropUrl ?? collection.posterUrl}
      fallback={collection.name}
      {...(collection.owned > 0 && collection.watched >= collection.owned && { flag: 'Gezien' })}
      width={width}
      autoFocus={autoFocus}
      onFocus={onFocus}
      onPress={() => router.push(`/collection/${collection.id}`)}
    />
  );
}

/**
 * A film of a collection that isn't here: asked for, announced, or to ask
 * for (OK then opens it in Ontdekken).
 */
export function TvMissingPartCard({
  part,
  width,
  canAsk,
  titled,
  onFocus,
}: {
  part: CollectionPart;
  width: number;
  canAsk: boolean;
  titled?: boolean;
  onFocus?: () => void;
}) {
  const state = missingPartLabel(part);
  const ask = canAsk && canRequestPart(part);
  return (
    <TvPressable
      accessibilityRole={ask ? 'link' : 'text'}
      accessibilityLabel={`${part.title}, ${state}${ask ? ', aanvragen' : ''}`}
      // Also focusable when it can't be asked for: the header tells what it is.
      onPress={() => {
        if (ask) {
          router.push({
            pathname: '/discover-title',
            params: { kind: 'movie', id: String(part.tmdbId) },
          });
        }
      }}
      onFocus={onFocus}
      focusStyle={noFocusStyle}
      style={{ width }}
    >
      {({ focused }) => (
        <>
          <CardFrame focused={focused} width={width} ratio={1.5}>
            <View style={[StyleSheet.absoluteFill, styles.missing]}>
              <ServerImage
                path={part.posterUrl}
                style={StyleSheet.absoluteFill as ViewStyle}
                fallback={part.title}
              />
            </View>
            <View style={styles.flag}>
              <Text style={styles.flagText}>{ask && focused ? 'Aanvragen' : state}</Text>
            </View>
          </CardFrame>
          {titled && (
            <>
              <Text
                style={[styles.cardTitle, focused && styles.cardTitleFocused]}
                numberOfLines={1}
              >
                {part.title}
              </Text>
              {part.year ? <Text style={styles.cardSub}>{part.year}</Text> : null}
            </>
          )}
        </>
      )}
    </TvPressable>
  );
}

const SLIDE = { duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true };

/**
 * A titled row. The focused card stays at the left edge and the row slides
 * under it (until the row's end is in view), so the eye doesn't have to
 * follow the focus across the screen. `render` gets the card's onFocus.
 *
 * Up or down into a row goes to the card drawn right under (or above) where
 * the focus was: usually the one at its left edge, as on Netflix. Android's
 * own search would pick the card at the same place in the row's layout,
 * which the slide doesn't move: from the 8th card of one row to the 8th of
 * the next, far from what is on screen (see rowFocusTarget).
 */
export function TvRow<T>({
  title,
  data,
  keyOf,
  itemWidth,
  render,
  onFocus,
  hidden,
}: {
  title: string;
  data: T[];
  keyOf: (item: T) => string;
  /** The width of one card: all cards of a row are as wide. */
  itemWidth: number;
  render: (item: T, index: number, onFocus: () => void) => ReactNode;
  /** A card of this row got the focus. */
  onFocus?: (item: T, index: number) => void;
  /** Above the focused row in a browse page: out of sight, but the remote can still reach it. */
  hidden?: boolean;
}) {
  const { inner } = useTvSizes();
  const [x] = useState(() => new Animated.Value(0));
  const step = itemWidth + CARD_GAP;
  const end = Math.max(0, data.length * step - CARD_GAP - inner);
  /** How far the row is slid now (where it was last sent). */
  const shift = useRef(0);
  const focusAt = useCallback(
    (index: number) => {
      shift.current = Math.min(end, index * step);
      Animated.timing(x, { ...SLIDE, toValue: -shift.current }).start();
    },
    [end, step, x],
  );
  const id = useId();
  // The cards' views, to give the focus to the one under where it was.
  const cards = useRef(new Map<number, HostInstance>());
  const row = useMemo<RowFocus>(
    () => ({
      id,
      register: (index, view) => {
        if (view) cards.current.set(index, view);
        else cards.current.delete(index);
      },
    }),
    [id],
  );
  // One context value per card, so the cards don't register again on every render.
  const slots = useMemo(
    () => data.map((_, index) => ({ row, index, last: index === data.length - 1 })),
    [data, row],
  );
  const focused = useCallback(
    (item: T, index: number) => {
      const settle = () => {
        focusAt(index);
        setFocusedCardCenter(index * step - shift.current + itemWidth / 2);
        onFocus?.(item, index);
      };
      const at = rowFocusTarget({
        index,
        length: data.length,
        enteredVertically: enteredRow(id) && keyedRecently(['up', 'down']),
        step,
        itemWidth,
        shift: shift.current,
        from: focusedCardCenter(),
      });
      const target = cards.current.get(at);
      if (index !== at && target) {
        void focusNow(target).then((moved) => {
          if (!moved) settle();
        });
        return;
      }
      settle();
    },
    [data.length, focusAt, id, itemWidth, onFocus, step],
  );
  if (data.length === 0) return null;
  return (
    <View style={[styles.row, hidden && { opacity: 0 }]}>
      <Text style={tvText.railTitle} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.rowViewport}>
        <Animated.View style={[styles.rowTrack, { transform: [{ translateX: x }] }]}>
          {/* `focused` reads the refs when a card gets the focus, never while rendering. */}
          {/* eslint-disable-next-line react-hooks/refs */}
          {data.map((item, index) => (
            <View key={keyOf(item)}>
              <RowContext.Provider value={slots[index]}>
                {render(item, index, () => focused(item, index))}
              </RowContext.Provider>
            </View>
          ))}
        </Animated.View>
      </View>
    </View>
  );
}

/** A row of posters that opens their titles. */
export function TvPosterRow({
  title,
  items,
  onFocus,
  hidden,
}: {
  title: string;
  items: ItemSummary[];
  onFocus?: (item: ItemSummary) => void;
  hidden?: boolean;
}) {
  const { poster } = useTvSizes();
  return (
    <TvRow
      title={title}
      data={items}
      keyOf={(item) => item.id}
      itemWidth={poster}
      hidden={hidden}
      onFocus={(item) => onFocus?.(item)}
      render={(item, _index, focus) => <TvPosterCard item={item} width={poster} onFocus={focus} />}
    />
  );
}

export const tvText = StyleSheet.create({
  h1: { color: colors.text, fontSize: 34, fontWeight: '900', letterSpacing: -0.4 },
  h2: { color: colors.text, fontSize: 22, fontWeight: '800' },
  body: { color: colors.text, fontSize: 17, lineHeight: 25 },
  muted: { color: colors.text2, fontSize: 16, lineHeight: 23 },
  small: { color: colors.text3, fontSize: 14 },
  railTitle: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
    paddingHorizontal: TV_GUTTER,
    letterSpacing: 0.1,
  },
  eyebrow: {
    color: colors.brass,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  } as TextStyle,
});

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 22,
    borderRadius: radius.s,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.glass,
  },
  buttonPrimary: { backgroundColor: colors.text },
  buttonFocused: { backgroundColor: colors.brass },
  buttonText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  iconButtonBox: { alignItems: 'center', width: 64 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
  },
  iconButtonLabel: {
    position: 'absolute',
    top: 56,
    width: 140,
    textAlign: 'center',
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.lineStrong,
  },
  chipOn: { backgroundColor: 'rgba(224,176,79,0.22)', borderColor: colors.brass },
  chipFocused: { backgroundColor: colors.brass, borderColor: colors.brass },
  chipText: { color: colors.text, fontWeight: '700', fontSize: 16 },
  frame: {
    borderRadius: radius.m,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  frameFocused: { borderColor: colors.brass, elevation: 12 },
  cardProgress: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  cardTitle: {
    color: colors.text2,
    fontWeight: '600',
    fontSize: 15,
    marginTop: 10,
    paddingHorizontal: 2,
  },
  cardTitleFocused: { color: colors.text },
  cardSub: { color: colors.text3, fontSize: 13, paddingHorizontal: 2 },
  wideShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '62%',
    backgroundColor: 'rgba(5,9,26,0.55)',
  },
  wideText: { position: 'absolute', left: 12, right: 12, bottom: 10 },
  wideName: { color: colors.text, fontSize: 16, fontWeight: '800' },
  wideSub: { color: colors.text2, fontSize: 13, fontWeight: '600', marginTop: 1 },
  playBubble: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  missing: { opacity: 0.55 },
  flag: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: colors.brass,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  flagText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  row: { gap: 2 },
  // The track starts a little left of the gutter, so the focused first card
  // has room to grow; cards slid past the gutter are cut off there.
  rowViewport: {
    marginLeft: TV_GUTTER - 12,
    paddingLeft: 12,
    paddingVertical: 14,
    overflow: 'hidden',
  },
  rowTrack: { flexDirection: 'row', gap: CARD_GAP },
});
