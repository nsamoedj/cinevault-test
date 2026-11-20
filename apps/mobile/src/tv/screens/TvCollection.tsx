// A collection on the TV: its name and "Begin met …" over the backdrop, and
// all its films in the order they came out, also the ones not here.

import { collectionLabel } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { ErrorView, Loading } from '../../components/ui';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors } from '../../theme';
import { FocusMemory } from '../focus';
import { HeroBackdrop } from '../Hero';
import { collectionSpot, createSpotStore } from '../spotlight';
import {
  CARD_GAP,
  TV_GUTTER,
  TvButton,
  TvMissingPartCard,
  TvPosterCard,
  tvText,
  useTvSizes,
} from '../ui';

const COLUMNS = 6;

export function TvCollection() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { api, user } = useSession();
  const { inner } = useTvSizes();
  const cardWidth = Math.floor((inner - CARD_GAP * (COLUMNS - 1)) / COLUMNS);
  const collection = useQuery({
    queryKey: keys.collection(Number(id)),
    queryFn: () => api.collection(Number(id)),
  });
  const data = collection.data;
  const store = useMemo(() => createSpotStore(data && collectionSpot(data)), [data]);
  if (collection.isPending) return <Loading />;
  if (collection.isError) {
    return <ErrorView error={collection.error} onRetry={() => void collection.refetch()} />;
  }
  const next = collection.data.next;
  const canAsk = user?.maxAge === undefined;
  return (
    <FocusMemory>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <HeroBackdrop store={store} dim />
        <FlatList
          style={{ flex: 1 }}
          data={collection.data.parts}
          numColumns={COLUMNS}
          keyExtractor={(part) => String(part.tmdbId)}
          renderItem={({ item: part, index }) =>
            part.item ? (
              <TvPosterCard
                item={part.item}
                width={cardWidth}
                titled
                autoFocus={!next && index === 0}
              />
            ) : (
              <TvMissingPartCard part={part} width={cardWidth} canAsk={canAsk} titled />
            )
          }
          columnWrapperStyle={{ gap: CARD_GAP }}
          contentContainerStyle={styles.grid}
          ListHeaderComponent={
            <View style={styles.head}>
              <Text style={tvText.eyebrow}>Collectie</Text>
              <Text style={tvText.h1}>{collection.data.name}</Text>
              <Text style={tvText.muted}>{collectionLabel(collection.data)}</Text>
              {collection.data.overview ? (
                <Text style={[tvText.body, styles.overview]} numberOfLines={4}>
                  {collection.data.overview}
                </Text>
              ) : null}
              {next && (
                <View style={styles.buttons}>
                  <TvButton
                    label={
                      collection.data.watched > 0
                        ? `Verder met ${next.title}`
                        : `Begin met ${next.title}`
                    }
                    icon="play"
                    primary
                    autoFocus
                    onPress={() => router.push(`/item/${next.id}`)}
                  />
                </View>
              )}
            </View>
          }
          removeClippedSubviews={false}
        />
      </View>
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  head: { paddingTop: 48, marginBottom: 20, gap: 6, maxWidth: 640 },
  overview: { marginTop: 6 },
  buttons: { flexDirection: 'row', marginTop: 14 },
  grid: { paddingHorizontal: TV_GUTTER, paddingBottom: 40, gap: 22 },
});
