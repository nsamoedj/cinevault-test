import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DiscoverCard } from '../../components/DiscoverCard';
import { Icon } from '../../components/Icon';
import { useCardWidths, useGrid } from '../../components/sizes';
import { Button, ErrorView, Loading, Rail, text } from '../../components/ui';
import { useSession } from '../../session';
import { colors, gutter, radius } from '../../theme';
import { isTV } from '../../tv/focus';
import { TvDiscover } from '../../tv/screens/TvDiscover';

/** Search results: movies and shows from TMDB, page by page. */
function Results({ query }: { query: string }) {
  const { api } = useSession();
  const { columns, cardWidth, gap } = useGrid();
  const pages = useInfiniteQuery({
    queryKey: ['discover', 'search', query],
    queryFn: ({ pageParam }) => api.discoverSearch(query, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  if (pages.isError) return <ErrorView error={pages.error} onRetry={() => void pages.refetch()} />;
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <FlatList
      key={columns}
      data={items}
      numColumns={columns}
      keyExtractor={(item) => `${item.kind}-${item.tmdbId}`}
      renderItem={({ item }) => <DiscoverCard item={item} width={cardWidth} />}
      columnWrapperStyle={{ gap }}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: 24, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      onEndReached={() => {
        if (pages.hasNextPage && !pages.isFetchingNextPage) void pages.fetchNextPage();
      }}
      ListEmptyComponent={
        pages.isPending ? (
          <ActivityIndicator color={colors.brass} />
        ) : (
          <Text style={text.muted}>Niets gevonden bij TMDB.</Text>
        )
      }
    />
  );
}

function Feed() {
  const { api } = useSession();
  const { poster } = useCardWidths();
  const feed = useQuery({ queryKey: ['discover', 'feed'], queryFn: api.discover });
  if (feed.isPending) return <Loading />;
  if (feed.isError) return <ErrorView error={feed.error} onRetry={() => void feed.refetch()} />;
  return (
    <ScrollView contentContainerStyle={{ gap: 26, paddingBottom: 24 }}>
      {feed.data.rows.map((row) => (
        <Rail
          key={row.id}
          title={row.title}
          data={row.items}
          keyOf={(item) => `${item.kind}-${item.tmdbId}`}
          render={(item) => <DiscoverCard item={item} width={poster} />}
          action={
            <Pressable
              accessibilityRole="link"
              hitSlop={8}
              onPress={() => router.push({ pathname: '/discover-row', params: { id: row.id } })}
              style={styles.more}
            >
              <Text style={styles.moreText}>Alles</Text>
              <Icon name="chevronRight" size={16} color={colors.text2} />
            </Pressable>
          }
        />
      ))}
      <View style={{ paddingHorizontal: gutter }}>
        <Button
          label="Verzoeken"
          icon="sparkle"
          kind="secondary"
          onPress={() => router.push('/requests')}
        />
      </View>
    </ScrollView>
  );
}

/** "Ontdekken": the newest releases to browse and ask for, with a search. */
function DiscoverScreen() {
  const params = useLocalSearchParams<{ q?: string }>();
  const [input, setInput] = useState(params.q ?? '');
  const [query, setQuery] = useState(params.q ?? '');
  // Arriving with ?q= again (from Zoeken, the tab stays open): search that.
  const [given, setGiven] = useState(params.q);
  if (params.q !== given) {
    setGiven(params.q);
    if (params.q) setInput(params.q);
  }
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 400);
    return () => clearTimeout(timer);
  }, [input]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.head}>
        <Text style={text.h1}>Ontdekken</Text>
        <Pressable
          accessibilityRole="link"
          hitSlop={8}
          onPress={() => router.push('/requests')}
          style={styles.more}
        >
          <Text style={styles.moreText}>Verzoeken</Text>
          <Icon name="chevronRight" size={16} color={colors.text2} />
        </Pressable>
      </View>
      <View style={styles.field}>
        <Icon name="search" size={22} color={colors.text3} />
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Zoek een film of serie bij TMDB"
          placeholderTextColor={colors.text3}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Zoeken bij TMDB"
        />
      </View>
      {query ? <Results query={query} /> : <Feed />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: gutter,
    paddingTop: 8,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    margin: gutter,
    paddingHorizontal: 14,
    minHeight: 52,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  input: { flex: 1, color: colors.text, fontSize: 17 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  moreText: { color: colors.text2, fontWeight: '600', fontSize: 14 },
});

// The TV has its own screens, for the remote.
export default isTV ? TvDiscover : DiscoverScreen;
