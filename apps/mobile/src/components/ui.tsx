import {
  airDateLabel,
  ApiError,
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
  upcomingLabel,
} from '@cinevault/shared';
import { Image } from 'expo-image';
import { Link, router } from 'expo-router';
import { type ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type ImageStyle,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { clockLabel } from '../format';
import { useSession } from '../session';
import { colors, gutter, radius } from '../theme';
import { carLayout, isCar, px } from '../car';
import { focusRing, isTV, TvPressable } from '../tv/focus';
import { Icon, type IconName } from './Icon';

export function Button({
  label,
  icon,
  kind = 'primary',
  onPress,
  disabled,
  style,
  accessibilityLabel,
}: {
  label: string;
  icon?: IconName;
  kind?: 'primary' | 'glass' | 'secondary';
  onPress?: PressableProps['onPress'];
  disabled?: boolean;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  const color = kind === 'primary' ? colors.ink : colors.text;
  // TvPressable: on a TV the remote's focus shows as a ring (phones never focus it).
  return (
    <TvPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.primary,
        kind === 'glass' && styles.glass,
        kind === 'secondary' && styles.secondary,
        isTV && styles.tvRing,
        isCar && styles.carButton,
        pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] },
        disabled && { opacity: 0.5 },
        style,
      ]}
      focusStyle={kind === 'primary' ? styles.focusOnBrass : focusRing}
    >
      {icon && <Icon name={icon} size={20} color={color} />}
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </TvPressable>
  );
}

/** A text field whose border shows the focus (on a TV, where the remote moves it). */
export function Input({ style, onFocus, onBlur, ...props }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={colors.text3}
      {...props}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={[style, focused && { borderColor: colors.brass }]}
    />
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  size = isCar ? 52 : 44,
  color = colors.text,
  style,
}: {
  icon: IconName;
  label: string;
  onPress?: PressableProps['onPress'];
  size?: number;
  color?: string;
  style?: ViewStyle;
}) {
  return (
    <TvPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { width: px(size), height: px(size), borderRadius: px(size) / 2 },
        isTV && styles.tvRing,
        pressed && { backgroundColor: colors.glass },
        style,
      ]}
    >
      <Icon name={icon} size={size * 0.55} color={color} />
    </TvPressable>
  );
}

/** An image from the server: the login token goes along, and it is cached on the phone. */
export function ServerImage({
  path,
  style,
  fallback,
  contentFit = 'cover',
}: {
  path: string | undefined;
  style: ViewStyle | ViewStyle[];
  fallback?: string;
  contentFit?: 'cover' | 'contain';
}) {
  const { api, authHeaders } = useSession();
  const uri = api.resolveUrl(path);
  if (!uri) {
    return (
      <View style={[styles.placeholder, style as ViewStyle]}>
        {fallback ? (
          <Text style={styles.placeholderText} numberOfLines={3}>
            {fallback}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <Image
      source={{ uri, headers: authHeaders }}
      style={[styles.image, style as ImageStyle]}
      contentFit={contentFit}
      transition={200}
      cachePolicy="disk"
      recyclingKey={uri}
    />
  );
}

export function ProgressBar({ share, style }: { share: number; style?: ViewStyle }) {
  return (
    <View style={[styles.progress, style]}>
      <View style={[styles.progressFill, { width: `${Math.min(1, Math.max(0, share)) * 100}%` }]} />
    </View>
  );
}

export function WatchedBadge() {
  return (
    <View style={styles.watched} accessibilityLabel="Gezien">
      <Icon name="check" size={14} color={colors.ink} />
    </View>
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

export function PosterCard({ item, width }: { item: ItemSummary; width: number }) {
  const share = posterShare(item);
  // The fixed width sits on a plain View: Link's Slot does not pass a style
  // function on, so a long title would otherwise widen the card.
  return (
    <View style={{ width }}>
      <Link href={`/item/${item.id}`} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${item.title}${item.year ? `, ${item.year}` : ''}`}
          style={{ width }}
        >
          <View style={[styles.cardImage, { width, height: width * 1.5 }]}>
            <ServerImage
              path={item.posterUrl}
              style={StyleSheet.absoluteFill as ViewStyle}
              fallback={item.title}
            />
            {item.progress?.watched && <WatchedBadge />}
            {share > 0 && <ProgressBar share={share} style={styles.cardProgress} />}
          </View>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {item.title}
          </Text>
          {item.year ? <Text style={styles.cardSub}>{item.year}</Text> : null}
        </Pressable>
      </Link>
    </View>
  );
}

function continueSubtitle(entry: ContinueEntry): string {
  const episode = entry.episode;
  if (!episode) return entry.item.year ? String(entry.item.year) : 'Film';
  const code = `S${episode.seasonNumber}:A${episode.episodeNumber}`;
  return episode.title ? `${code} · ${episode.title}` : code;
}

export function ContinueCard({ entry, width }: { entry: ContinueEntry; width: number }) {
  const image = entry.episode?.stillUrl ?? entry.backdropUrl ?? entry.item.posterUrl;
  const share = entry.durationMs && entry.positionMs > 0 ? entry.positionMs / entry.durationMs : 0;
  const left = entry.durationMs ? entry.durationMs - entry.positionMs : undefined;
  const sub = continueSubtitle(entry);
  return (
    <View style={{ width }}>
      <Link href={`/play/${entry.fileId}`} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${entry.item.title}, ${sub}${entry.kind === 'next' ? ', volgende aflevering' : ''}`}
          style={{ width }}
        >
          <View style={[styles.cardImage, { width, height: (width * 9) / 16 }]}>
            <ServerImage
              path={image}
              style={StyleSheet.absoluteFill as ViewStyle}
              fallback={entry.item.title}
            />
            <View style={styles.playBubble}>
              <Icon name="play" size={18} />
            </View>
            {entry.kind === 'next' && (
              <View style={styles.flag}>
                <Text style={styles.flagText}>Volgende aflevering</Text>
              </View>
            )}
            {share > 0 && <ProgressBar share={share} style={styles.cardProgress} />}
          </View>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {entry.item.title}
          </Text>
          <Text style={styles.cardSub} numberOfLines={1}>
            {sub}
            {entry.kind === 'resume' && left ? ` · nog ${clockLabel(left / 1000)}` : ''}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

/** "Nieuwe afleveringen": a wide card with the episode; it opens the show. */
export function NewEpisodesCard({ entry, width }: { entry: NewEpisodes; width: number }) {
  const image = entry.stillUrl ?? entry.item.backdropUrl ?? entry.item.posterUrl;
  const sub = newEpisodesLabel(entry);
  return (
    <View style={{ width }}>
      <Link href={`/item/${entry.item.id}`} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${entry.item.title}, ${sub}`}
          style={{ width }}
        >
          <View style={[styles.cardImage, { width, height: (width * 9) / 16 }]}>
            <ServerImage
              path={image}
              style={StyleSheet.absoluteFill as ViewStyle}
              fallback={entry.item.title}
            />
            {isRecent(entry.addedAt) && (
              <View style={styles.flag}>
                <Text style={styles.flagText}>
                  {entry.count > 1 ? `${entry.count} nieuw` : 'Nieuw'}
                </Text>
              </View>
            )}
            {entry.fraction ? (
              <ProgressBar share={entry.fraction} style={styles.cardProgress} />
            ) : null}
          </View>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {entry.item.title}
          </Text>
          <Text style={styles.cardSub} numberOfLines={1}>
            {sub}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

/** "Binnenkort": a wide card with the day the next episode airs; it opens the show. */
export function UpcomingCard({ entry, width }: { entry: UpcomingEpisode; width: number }) {
  const image = entry.item.backdropUrl ?? entry.item.posterUrl;
  const when = airDateLabel(entry.airDate);
  const sub = upcomingLabel(entry);
  return (
    <View style={{ width }}>
      <Link href={`/item/${entry.item.id}`} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${entry.item.title}, ${sub}, ${when}`}
          style={{ width }}
        >
          <View style={[styles.cardImage, { width, height: (width * 9) / 16 }]}>
            <ServerImage
              path={image}
              style={StyleSheet.absoluteFill as ViewStyle}
              fallback={entry.item.title}
            />
            <View style={styles.flag}>
              <Text style={styles.flagText}>{when}</Text>
            </View>
          </View>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {entry.item.title}
          </Text>
          <Text style={styles.cardSub} numberOfLines={1}>
            {sub}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

/** A collection ("Harry Potter Collection"): a wide card that opens it. */
export function CollectionCard({
  collection,
  width,
}: {
  collection: CollectionSummary;
  width: number;
}) {
  const sub = collectionLabel(collection);
  const watched = collection.owned > 0 && collection.watched >= collection.owned;
  return (
    <View style={{ width }}>
      <Link href={`/collection/${collection.id}`} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${collection.name}, ${sub}`}
          style={{ width }}
        >
          <View style={[styles.cardImage, { width, height: (width * 9) / 16 }]}>
            <ServerImage
              path={collection.backdropUrl ?? collection.posterUrl}
              style={StyleSheet.absoluteFill as ViewStyle}
              fallback={collection.name}
            />
            {watched && <WatchedBadge />}
          </View>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {collection.name}
          </Text>
          <Text style={styles.cardSub} numberOfLines={1}>
            {sub}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

/**
 * A film of a collection that isn't here: asked for, announced, or to ask for
 * (it then opens the film in Ontdekken).
 */
export function MissingPartCard({
  part,
  width,
  canAsk,
}: {
  part: CollectionPart;
  width: number;
  canAsk: boolean;
}) {
  const state = missingPartLabel(part);
  const ask = canAsk && canRequestPart(part);
  return (
    <View style={{ width }}>
      <Pressable
        accessibilityRole={ask ? 'link' : undefined}
        accessibilityLabel={`${part.title}, ${state}${ask ? ', aanvragen' : ''}`}
        disabled={!ask}
        onPress={() =>
          router.push({
            pathname: '/discover-title',
            params: { kind: 'movie', id: String(part.tmdbId) },
          })
        }
        style={{ width }}
      >
        <View style={[styles.cardImage, styles.missing, { width, height: width * 1.5 }]}>
          <ServerImage
            path={part.posterUrl}
            style={StyleSheet.absoluteFill as ViewStyle}
            fallback={part.title}
          />
          <View style={styles.flag}>
            <Text style={styles.flagText}>{state}</Text>
          </View>
        </View>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {part.title}
        </Text>
        <Text style={styles.cardSub}>
          {part.year ?? ''}
          {ask ? `${part.year ? ' · ' : ''}Aanvragen` : ''}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The title as TMDB's logo (a transparent PNG) in a box of `width` × `height`,
 * else as text. The text also comes back when the logo can't load.
 */
export function TitleLogo({
  path,
  title,
  width,
  height,
  align = 'center',
  textStyle,
  numberOfLines = 2,
}: {
  path: string | undefined;
  title: string;
  width: number;
  height: number;
  align?: 'center' | 'left';
  textStyle: TextStyle | TextStyle[];
  numberOfLines?: number;
}) {
  const { api, authHeaders } = useSession();
  const [failed, setFailed] = useState<string>();
  const uri = api.resolveUrl(path);
  if (!uri || failed === uri) {
    return (
      <Text style={textStyle} numberOfLines={numberOfLines} accessibilityRole="header">
        {title}
      </Text>
    );
  }
  return (
    <Image
      source={{ uri, headers: authHeaders }}
      style={{ width, height }}
      contentFit="contain"
      contentPosition={align === 'left' ? 'left center' : 'center'}
      cachePolicy="disk"
      recyclingKey={uri}
      accessible
      accessibilityRole="header"
      accessibilityLabel={title}
      onError={() => setFailed(uri)}
    />
  );
}

/** A titled row that scrolls sideways. */
export function Rail<T>({
  title,
  data,
  keyOf,
  render,
  action,
}: {
  title: string;
  data: T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  action?: ReactNode;
}) {
  return (
    <View style={styles.rail}>
      <View style={styles.railHeader}>
        <Text style={styles.railTitle} accessibilityRole="header">
          {title}
        </Text>
        {action}
      </View>
      <FlatList
        horizontal
        data={data}
        keyExtractor={keyOf}
        renderItem={({ item }) => <>{render(item)}</>}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.railContent}
        ItemSeparatorComponent={() => <View style={{ width: px(10) }} />}
        initialNumToRender={6}
        windowSize={5}
      />
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.brass} size="large" />
      {label ? <Text style={styles.muted}>{label}</Text> : null}
    </View>
  );
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Niet gevonden.';
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /network|fetch|failed to connect|timeout/i.test(message)
    ? 'De CineVault-server is niet bereikbaar. Staat Tailscale aan, of ben je thuis?'
    : message;
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <View style={styles.center}>
      <Icon name="alert" size={40} color={colors.danger} />
      <Text style={[styles.muted, { textAlign: 'center' }]}>{errorText(error)}</Text>
      {onRetry && <Button label="Opnieuw proberen" kind="secondary" onPress={onRetry} />}
    </View>
  );
}

export function Avatar({
  name,
  color,
  size = 40,
}: {
  name: string;
  color?: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.18,
        backgroundColor: color ?? colors.brass,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: colors.ink, fontWeight: '800', fontSize: size * 0.45 }}>
        {name.trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
}

export const text = StyleSheet.create({
  h1: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.3 },
  h2: { color: colors.text, fontSize: 19, fontWeight: '700' },
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.text2, fontSize: 14, lineHeight: 20 },
  small: { color: colors.text3, fontSize: 12 },
  eyebrow: {
    color: colors.brass,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  } as TextStyle,
});

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: radius.s,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primary: { backgroundColor: colors.brass },
  glass: { backgroundColor: colors.glass },
  secondary: { borderWidth: 1, borderColor: colors.lineStrong },
  buttonText: { fontSize: 16, fontWeight: '700' },
  carButton: { minHeight: carLayout.button, paddingHorizontal: 26 },
  // Room for the focus ring, so the focus doesn't shift the layout.
  tvRing: { borderWidth: 2, borderColor: 'transparent' },
  focusOnBrass: { borderColor: colors.text, transform: [{ scale: 1.05 }] },
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  image: { backgroundColor: colors.surface },
  placeholder: {
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  placeholderText: { fontSize: 14, color: colors.text2, fontWeight: '700', textAlign: 'center' },
  progress: { height: 4, backgroundColor: 'rgba(5,9,26,0.65)', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.brass },
  watched: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardImage: { borderRadius: radius.m, overflow: 'hidden', backgroundColor: colors.surface },
  missing: { opacity: 0.6 },
  cardProgress: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  cardTitle: { color: colors.text, fontWeight: '600', fontSize: 14, marginTop: 6 },
  cardSub: { color: colors.text3, fontSize: 12 },
  playBubble: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -20,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: 'rgba(242,244,250,0.9)',
    backgroundColor: 'rgba(5,9,26,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 3,
  },
  flag: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: colors.brass,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  flagText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  rail: { gap: 10 },
  railHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: gutter,
  },
  railTitle: { color: colors.text, fontSize: 19, fontWeight: '700' },
  railContent: { paddingHorizontal: gutter },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  muted: { color: colors.text2, fontSize: 15 },
});
