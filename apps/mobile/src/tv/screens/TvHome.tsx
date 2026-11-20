// The TV start page, as on Netflix: the billboard with a featured title and
// its buttons (the focus starts on "Afspelen"), the rows peeking in below.
// Down goes into the rows: the header then shows the title that has the
// focus, and the focused row stays just under it.

import type { FeaturedItem, HomeRow } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ErrorView, Loading } from '../../components/ui';
import { keys } from '../../keys';
import { useMyListToggle } from '../../myList';
import { useSession } from '../../session';
import { colors } from '../../theme';
import { type BrowseRow, TvBrowse } from '../Browse';
import { FocusMemory } from '../focus';
import { HeroBackdrop, HeroInfo, HeroText } from '../Hero';
import {
  collectionSpot,
  continueSpot,
  createSpotStore,
  SpotThemeMusic,
  featuredSpot,
  itemSpot,
  newEpisodesSpot,
  type SpotStore,
  upcomingSpot,
} from '../spotlight';
import {
  TV_GUTTER,
  TvButton,
  TvCollectionCard,
  TvContinueCard,
  TvNewEpisodesCard,
  TvPosterRow,
  TvRow,
  tvText,
  TvUpcomingCard,
  useTvSizes,
} from '../ui';

/** A new featured title this often, while the billboard has the focus. */
const ROTATE_MS = 12_000;

function Billboard({
  items,
  store,
  onFocus,
}: {
  items: FeaturedItem[];
  store: SpotStore;
  onFocus: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [here, setHere] = useState(true);
  const item = items[index % items.length] as FeaturedItem;
  const spot = useMemo(() => featuredSpot(item), [item]);
  const list = useMyListToggle(item.id, item.inMyList ?? false);
  const resume = item.play?.positionMs && item.play.positionMs >= 60_000;

  // The header's backdrop is this title while the billboard has the focus.
  useEffect(() => {
    if (here) store.set(spot);
  }, [here, spot, store]);
  useEffect(() => {
    if (!here || items.length < 2) return;
    const timer = setTimeout(() => setIndex((i) => i + 1), ROTATE_MS);
    return () => clearTimeout(timer);
  }, [here, index, items.length]);

  const focus = {
    onFocus: () => {
      setHere(true);
      onFocus();
    },
    onBlur: () => setHere(false),
  };
  return (
    <View style={styles.billboard}>
      <HeroText spot={spot} size="large" />
      {/*
        The buttons stay the same views when the title changes (every 12 s), so
        the focus stays on the one it is on: a button that went away for a title
        without a file to play took the focus with it (Android then put it in the
        menu), and one that became the autoFocus pulled it over.
      */}
      <View style={styles.buttons}>
        <TvButton
          label={item.play ? (resume ? 'Verder kijken' : 'Afspelen') : 'Bekijken'}
          icon="play"
          primary
          autoFocus
          onPress={() => router.push(item.play ? `/play/${item.play.fileId}` : `/item/${item.id}`)}
          {...focus}
        />
        <TvButton
          label="Meer info"
          icon="info"
          onPress={() => router.push(`/item/${item.id}`)}
          {...focus}
        />
        <TvButton
          label={list.label}
          icon={list.on ? 'check' : 'plus'}
          onPress={list.toggle}
          lastInLine
          {...focus}
        />
      </View>
      {items.length > 1 && (
        <View style={styles.dots}>
          {items.map((featured, i) => (
            <View
              key={featured.id}
              style={[styles.dot, i === index % items.length && styles.dotOn]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function rowsOf(
  home: { rows: HomeRow[] },
  continueEntries: Parameters<typeof continueSpot>[0][],
  store: SpotStore,
  sizes: { landscape: number },
): BrowseRow[] {
  const rows: BrowseRow[] = [];
  if (continueEntries.length > 0) {
    rows.push({
      key: 'continue',
      render: ({ hidden, onFocus }) => (
        <TvRow
          title="Verder kijken"
          data={continueEntries}
          // By title: the card stays (with the focus) when it moves on to the next episode.
          keyOf={(entry) => entry.item.id}
          itemWidth={sizes.landscape}
          hidden={hidden}
          onFocus={(entry) => {
            onFocus();
            store.set(continueSpot(entry));
          }}
          render={(entry, _index, focus) => (
            <TvContinueCard entry={entry} width={sizes.landscape} onFocus={focus} />
          )}
        />
      ),
    });
  }
  for (const row of home.rows) {
    if (row.upcoming) {
      const upcoming = row.upcoming;
      rows.push({
        key: row.id,
        render: ({ hidden, onFocus }) => (
          <TvRow
            title={row.title}
            data={upcoming}
            keyOf={(entry) => entry.item.id}
            itemWidth={sizes.landscape}
            hidden={hidden}
            onFocus={(entry) => {
              onFocus();
              store.set(upcomingSpot(entry));
            }}
            render={(entry, _index, focus) => (
              <TvUpcomingCard entry={entry} width={sizes.landscape} onFocus={focus} />
            )}
          />
        ),
      });
    } else if (row.collections) {
      const collections = row.collections;
      rows.push({
        key: row.id,
        render: ({ hidden, onFocus }) => (
          <TvRow
            title={row.title}
            data={collections}
            keyOf={(collection) => String(collection.id)}
            itemWidth={sizes.landscape}
            hidden={hidden}
            onFocus={(collection) => {
              onFocus();
              store.set(collectionSpot(collection));
            }}
            render={(collection, _index, focus) => (
              <TvCollectionCard collection={collection} width={sizes.landscape} onFocus={focus} />
            )}
          />
        ),
      });
    } else if (row.episodes) {
      const episodes = row.episodes;
      rows.push({
        key: row.id,
        render: ({ hidden, onFocus }) => (
          <TvRow
            title={row.title}
            data={episodes}
            keyOf={(entry) => entry.item.id}
            itemWidth={sizes.landscape}
            hidden={hidden}
            onFocus={(entry) => {
              onFocus();
              store.set(newEpisodesSpot(entry));
            }}
            render={(entry, _index, focus) => (
              <TvNewEpisodesCard entry={entry} width={sizes.landscape} onFocus={focus} />
            )}
          />
        ),
      });
    } else {
      rows.push({
        key: row.id,
        render: ({ hidden, onFocus }) => (
          <TvPosterRow
            title={row.title}
            items={row.items}
            hidden={hidden}
            onFocus={(item) => {
              onFocus();
              store.set(itemSpot(item));
            }}
          />
        ),
      });
    }
  }
  return rows;
}

export function TvHome() {
  const { api } = useSession();
  const { landscape } = useTvSizes();
  const home = useQuery({ queryKey: keys.home, queryFn: api.home });
  const entries = useQuery({ queryKey: keys.continue, queryFn: api.continueWatching });
  const [store] = useState(() => createSpotStore());

  const rows = useMemo(
    () => (home.data ? rowsOf(home.data, entries.data ?? [], store, { landscape }) : []),
    [home.data, entries.data, store, landscape],
  );
  const featured = home.data?.featured;
  const top = useMemo(
    () =>
      featured && featured.length > 0
        ? (onFocus: () => void) => <Billboard items={featured} store={store} onFocus={onFocus} />
        : undefined,
    [featured, store],
  );

  if (home.isPending) return <Loading />;
  if (home.isError) return <ErrorView error={home.error} onRetry={() => void home.refetch()} />;

  if (rows.length === 0 && !featured?.length) {
    return (
      <View style={styles.empty}>
        <Text style={tvText.h1}>Welkom bij CineVault</Text>
        <Text style={tvText.muted}>De bibliotheek is nog leeg. Start een scan op de server.</Text>
      </View>
    );
  }

  return (
    <FocusMemory>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <SpotThemeMusic store={store} />
        <TvBrowse
          background={<HeroBackdrop store={store} />}
          header={<HeroInfo store={store} />}
          top={top}
          rows={rows}
        />
      </View>
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  billboard: { gap: 14, paddingBottom: 4 },
  buttons: { flexDirection: 'row', gap: 14, marginTop: 4 },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.glass },
  dotOn: { width: 22, backgroundColor: colors.brass },
  empty: {
    flex: 1,
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: TV_GUTTER,
    backgroundColor: colors.bg,
  },
});
