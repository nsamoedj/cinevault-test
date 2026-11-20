import type { FeaturedItem, HomeRow } from '@cinevault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { carLayout, isCar, px } from '../../car';
import { Icon } from '../../components/Icon';
import {
  Button,
  CollectionCard,
  ContinueCard,
  IconButton,
  ErrorView,
  Loading,
  NewEpisodesCard,
  PosterCard,
  Rail,
  ServerImage,
  text,
  TitleLogo,
  UpcomingCard,
} from '../../components/ui';
import { qualityBadges, useCardWidths, useContentWidth } from '../../components/sizes';
import { runtimeLabel } from '../../format';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors, gutter } from '../../theme';
import { CastIcon } from '../../components/CastIcon';
import { NotificationBell } from '../../components/Notifications';
import { useMyListToggle } from '../../myList';
import { isTV } from '../../tv/focus';
import { TvHome } from '../../tv/screens/TvHome';

function Hero({ items }: { items: FeaturedItem[] }) {
  const [index, setIndex] = useState(0);
  const item = items[index % items.length];
  if (!item) return null;
  return <HeroItem key={item.id} item={item} items={items} index={index} setIndex={setIndex} />;
}

function HeroItem({
  item,
  items,
  index,
  setIndex,
}: {
  item: FeaturedItem;
  items: FeaturedItem[];
  index: number;
  setIndex: (index: number) => void;
}) {
  const { height: screenHeight } = useWindowDimensions();
  const width = useContentWidth();
  const insets = useSafeAreaInsets();
  const list = useMyListToggle(item.id, item.inMyList ?? false);
  // In a car the screen is wide and low: the billboard leaves room for the first row.
  const height = isCar
    ? // Whole pixels at the car's density, so no seam shows under the backdrop.
      4 * Math.round(Math.max(360, screenHeight * carLayout.hero) / 4)
    : Math.min(620, Math.max(420, width * 1.15));
  const resume = item.play?.positionMs && item.play.positionMs >= 60_000;
  const facts = [
    item.rating ? `★ ${item.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}` : '',
    item.year ? String(item.year) : '',
    item.type === 'SHOW' ? 'Serie' : runtimeLabel(item.runtimeMinutes),
    ...qualityBadges(item.height, item.hdrFormat),
  ].filter(Boolean);
  return (
    <View style={{ height }}>
      <ServerImage path={item.backdropUrl} style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={['rgba(10,18,48,0.55)', 'rgba(10,18,48,0)', 'rgba(10,18,48,0.75)', colors.bg]}
        locations={[0, 0.25, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />
      {isCar && (
        // The text sits on the left: darken that side.
        <LinearGradient
          colors={['rgba(10,18,48,0.85)', 'rgba(10,18,48,0)']}
          locations={[0, 0.65]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      <Text style={[styles.brand, { top: insets.top + 10 }]}>
        Cine<Text style={{ color: colors.brass }}>Vault</Text>
      </Text>
      <View style={[styles.cast, { top: insets.top + 2 }]}>
        <NotificationBell />
        <CastIcon />
      </View>
      <View style={[styles.heroContent, isCar && styles.carContent]}>
        <Text style={text.eyebrow}>{item.type === 'SHOW' ? 'Serie' : 'Film'}</Text>
        <TitleLogo
          key={item.id}
          path={item.logoUrl}
          title={item.title}
          width={Math.min(width - 2 * px(gutter), px(isCar ? 380 : 320))}
          height={px(isCar ? 110 : 96)}
          {...(isCar && { align: 'left' as const })}
          textStyle={isCar ? [styles.heroTitle, styles.carLeft] : styles.heroTitle}
        />
        <Text style={styles.facts}>{facts.join('  ·  ')}</Text>
        {item.overview ? (
          <Text
            style={[styles.overview, isCar && styles.carOverview]}
            numberOfLines={isCar ? 3 : 2}
          >
            {item.overview}
          </Text>
        ) : null}
        <View style={[styles.heroButtons, isCar && styles.carButtons]}>
          {item.play && (
            <Button
              label={resume ? 'Verder kijken' : 'Afspelen'}
              icon="play"
              style={isCar ? styles.carButton : { flex: 1 }}
              onPress={() => router.push(`/play/${item.play?.fileId}`)}
            />
          )}
          <Button
            label="Meer info"
            icon="info"
            kind="glass"
            style={isCar ? styles.carButton : { flex: 1 }}
            onPress={() => router.push(`/item/${item.id}`)}
          />
          <IconButton
            icon={list.on ? 'check' : 'plus'}
            label={list.on ? 'Uit Mijn lijst halen' : 'Aan Mijn lijst toevoegen'}
            color={list.on ? colors.brass : colors.text}
            onPress={list.toggle}
            style={isCar ? { ...styles.listButton, ...styles.carList } : styles.listButton}
          />
        </View>
        {items.length > 1 && (
          <View style={styles.dots}>
            {items.map((featured, i) => (
              <Pressable
                key={featured.id}
                accessibilityRole="button"
                accessibilityLabel={featured.title}
                hitSlop={8}
                onPress={() => setIndex(i)}
                style={[styles.dot, i === index && styles.dotOn]}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function ContinueRow() {
  const { api } = useSession();
  const { landscape } = useCardWidths();
  const entries = useQuery({ queryKey: keys.continue, queryFn: api.continueWatching });
  if (!entries.data || entries.data.length === 0) return null;
  return (
    <Rail
      title="Verder kijken"
      data={entries.data}
      keyOf={(entry) => `${entry.item.id}-${entry.fileId}`}
      render={(entry) => <ContinueCard entry={entry} width={landscape} />}
    />
  );
}

function PosterRow({ row }: { row: HomeRow }) {
  const { poster, landscape } = useCardWidths();
  if (row.upcoming) {
    return (
      <Rail
        title={row.title}
        data={row.upcoming}
        keyOf={(entry) => entry.item.id}
        render={(entry) => <UpcomingCard entry={entry} width={landscape} />}
        action={
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Agenda"
            hitSlop={8}
            onPress={() => router.push({ pathname: '/calendar', params: { scope: 'all' } })}
            style={styles.more}
          >
            <Text style={styles.moreText}>Agenda</Text>
            <Icon name="chevronRight" size={16} color={colors.text2} />
          </Pressable>
        }
      />
    );
  }
  if (row.collections) {
    return (
      <Rail
        title={row.title}
        data={row.collections}
        keyOf={(collection) => String(collection.id)}
        render={(collection) => <CollectionCard collection={collection} width={landscape} />}
        action={
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Alle collecties"
            hitSlop={8}
            onPress={() => router.push('/collections')}
            style={styles.more}
          >
            <Text style={styles.moreText}>Alles</Text>
            <Icon name="chevronRight" size={16} color={colors.text2} />
          </Pressable>
        }
      />
    );
  }
  if (row.episodes) {
    return (
      <Rail
        title={row.title}
        data={row.episodes}
        keyOf={(entry) => entry.item.id}
        render={(entry) => <NewEpisodesCard entry={entry} width={landscape} />}
      />
    );
  }
  return (
    <Rail
      title={row.title}
      data={row.items}
      keyOf={(item) => item.id}
      render={(item) => <PosterCard item={item} width={poster} />}
      action={
        row.libraryId || row.id === 'my-list' ? (
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            onPress={() =>
              row.id === 'my-list'
                ? router.push('/my-list')
                : router.push({
                    pathname: '/library',
                    params: {
                      id: row.libraryId ?? '',
                      sort: row.sort ?? '',
                      genre: row.genre ?? '',
                    },
                  })
            }
            style={styles.more}
          >
            <Text style={styles.moreText}>Alles</Text>
            <Icon name="chevronRight" size={16} color={colors.text2} />
          </Pressable>
        ) : undefined
      }
    />
  );
}

function HomeScreen() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const home = useQuery({ queryKey: keys.home, queryFn: api.home });
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['items'] }),
      queryClient.invalidateQueries({ queryKey: keys.continue }),
    ]);
    setRefreshing(false);
  }

  if (home.isPending) return <Loading />;
  if (home.isError) return <ErrorView error={home.error} onRetry={() => void home.refetch()} />;
  const { featured, rows } = home.data;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingBottom: 24,
        paddingTop: featured.length ? 0 : insets.top + 16,
      }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={colors.brass}
          colors={[colors.brass]}
          progressBackgroundColor={colors.surface}
        />
      }
    >
      {featured.length > 0 && <Hero items={featured} />}
      <View style={{ gap: px(26) }}>
        <ContinueRow />
        {rows.map((row) => (
          <PosterRow key={row.id} row={row} />
        ))}
        {featured.length === 0 && rows.length === 0 && (
          <Text style={[text.muted, { padding: gutter }]}>
            De bibliotheek is nog leeg. Start een scan op de server.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  cast: { position: 'absolute', right: gutter - 8, flexDirection: 'row', alignItems: 'center' },
  listButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(242,244,250,0.6)',
    backgroundColor: 'rgba(10,18,48,0.35)',
  },
  brand: {
    position: 'absolute',
    left: gutter,
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  heroContent: {
    position: 'absolute',
    left: gutter,
    right: gutter,
    bottom: 18,
    alignItems: 'center',
    gap: 8,
  },
  heroTitle: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 16,
  },
  facts: { color: colors.text2, fontWeight: '600', fontSize: 13 },
  overview: { color: colors.text, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  heroButtons: { flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 6 },
  // In a car: on the left, in a column, with buttons as wide as their text.
  carContent: {
    right: undefined,
    width: carLayout.column,
    maxWidth: '62%',
    alignItems: 'flex-start',
    bottom: 28,
  },
  carLeft: { textAlign: 'left' },
  carOverview: { textAlign: 'left', fontSize: 16, lineHeight: 23 },
  carButtons: { alignSelf: 'flex-start', marginTop: 10, gap: 12 },
  carButton: { minWidth: 200 },
  carList: { width: 56, height: 56, borderRadius: 28 },
  dots: { flexDirection: 'row', gap: 6, marginTop: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.glass },
  dotOn: { width: 22, backgroundColor: colors.brass },
  more: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  moreText: { color: colors.text2, fontWeight: '600', fontSize: 14 },
});

// The TV has its own screens, for the remote.
export default isTV ? TvHome : HomeScreen;
