import { useInfiniteQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DiscoverCard } from '../components/DiscoverCard';
import { useGrid } from '../components/sizes';
import { ErrorView, IconButton, Loading, text } from '../components/ui';
import { useSession } from '../session';
import { colors, gutter } from '../theme';
import { isTV } from '../tv/focus';
import { TvDiscoverRow } from '../tv/screens/TvDiscoverRow';

/** One row of "Ontdekken", page by page. */
function DiscoverRowScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { columns, cardWidth, gap } = useGrid();
  const pages = useInfiniteQuery({
    queryKey: ['discover', 'row', id],
    queryFn: ({ pageParam }) => api.discoverRow(id, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.head}>
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <Text style={[text.h1, { flex: 1 }]} numberOfLines={1}>
          {pages.data?.pages[0]?.title ?? 'Ontdekken'}
        </Text>
      </View>
      {pages.isPending ? (
        <Loading />
      ) : pages.isError ? (
        <ErrorView error={pages.error} onRetry={() => void pages.refetch()} />
      ) : (
        <FlatList
          key={columns}
          data={pages.data.pages.flatMap((p) => p.items)}
          numColumns={columns}
          keyExtractor={(item) => `${item.kind}-${item.tmdbId}`}
          renderItem={({ item }) => <DiscoverCard item={item} width={cardWidth} />}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={{ padding: gutter, gap: 16, paddingBottom: 32 }}
          onEndReached={() => {
            if (pages.hasNextPage && !pages.isFetchingNextPage) void pages.fetchNextPage();
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
});

// The TV has its own screens, for the remote.
export default isTV ? TvDiscoverRow : DiscoverRowScreen;
