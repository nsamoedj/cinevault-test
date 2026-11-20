// One row of "Ontdekken" on the TV, as a grid that loads more at the end.

import { useInfiniteQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet, Text } from 'react-native';
import { ErrorView, Loading } from '../../components/ui';
import { useSession } from '../../session';
import { colors } from '../../theme';
import { TvDiscoverCard } from '../discover';
import { FocusMemory } from '../focus';
import { CARD_GAP, TV_GUTTER, tvText, useTvSizes } from '../ui';

const COLUMNS = 6;

export function TvDiscoverRow() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { inner } = useTvSizes();
  const cardWidth = Math.floor((inner - CARD_GAP * (COLUMNS - 1)) / COLUMNS);
  const pages = useInfiniteQuery({
    queryKey: ['discover', 'row', id],
    queryFn: ({ pageParam }) => api.discoverRow(id, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  if (pages.isPending) return <Loading />;
  if (pages.isError) return <ErrorView error={pages.error} onRetry={() => void pages.refetch()} />;
  const items = pages.data.pages.flatMap((p) => p.items);
  return (
    <FocusMemory>
      <FlatList
        style={{ flex: 1, backgroundColor: colors.bg }}
        data={items}
        numColumns={COLUMNS}
        keyExtractor={(item) => `${item.kind}-${item.tmdbId}`}
        renderItem={({ item, index }) => (
          <TvDiscoverCard item={item} width={cardWidth} autoFocus={index === 0} titled />
        )}
        columnWrapperStyle={{ gap: CARD_GAP }}
        contentContainerStyle={styles.grid}
        ListHeaderComponent={
          <Text style={[tvText.h1, styles.title]}>{pages.data.pages[0]?.title}</Text>
        }
        onEndReached={() => {
          if (pages.hasNextPage && !pages.isFetchingNextPage) void pages.fetchNextPage();
        }}
        removeClippedSubviews={false}
      />
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  title: { paddingTop: 32, marginBottom: 12 },
  grid: { paddingHorizontal: TV_GUTTER, paddingBottom: 40, gap: 22 },
});
