import type { ItemSort } from '@cinevault/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../components/Icon';
import { useGrid } from '../../components/sizes';
import { ErrorView, Loading, PosterCard, text } from '../../components/ui';
import { countLabel, libraryLabel as label } from '../../format';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors, gutter, radius } from '../../theme';
import { isTV } from '../../tv/focus';
import { TvLibrary } from '../../tv/screens/TvLibrary';

const PAGE_SIZE = 60;

const SORTS: { id: ItemSort; label: string }[] = [
  { id: 'title', label: 'Titel (A-Z)' },
  { id: 'added', label: 'Nieuw toegevoegd' },
  { id: 'year', label: 'Jaar' },
  { id: 'rating', label: 'Waardering' },
];

function Chip({ label: name, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.chipText, on && { color: colors.ink }]}>{name}</Text>
    </Pressable>
  );
}

/** A list to pick from, as a sheet from the bottom. */
function Picker<T extends string>({
  title,
  options,
  value,
  onChange,
  onClose,
}: {
  title: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  onClose: () => void;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Sluiten" />
      <SafeAreaView edges={['bottom']} style={styles.sheet}>
        <Text style={[text.h2, { marginBottom: 8 }]}>{title}</Text>
        <ScrollView style={{ maxHeight: 420 }}>
          {options.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: option.id === value }}
              onPress={() => {
                onChange(option.id);
                onClose();
              }}
              style={[styles.option, option.id === value && { backgroundColor: colors.brassSoft }]}
            >
              <Text style={text.body}>{option.label}</Text>
              {option.id === value && <Icon name="check" size={20} color={colors.brass} />}
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function LibraryScreen() {
  const { api } = useSession();
  const params = useLocalSearchParams<{ id?: string; sort?: string; genre?: string }>();
  const { columns, cardWidth, gap } = useGrid();
  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const all = libraries.data ?? [];
  const library = all.find((l) => l.id === params.id) ?? all[0];
  const id = library?.id ?? '';
  const sort = (SORTS.find((s) => s.id === params.sort)?.id ?? 'title') as ItemSort;
  const genre = params.genre ?? '';
  const [picking, setPicking] = useState<'sort' | 'genre'>();

  const genres = useQuery({
    queryKey: keys.genres(id),
    queryFn: () => api.genres(id),
    enabled: Boolean(id),
  });
  const items = useInfiniteQuery({
    queryKey: keys.items(id, sort, genre),
    queryFn: ({ pageParam }) =>
      api.items(id, {
        page: pageParam,
        pageSize: PAGE_SIZE,
        ...(sort !== 'title' && { sort }),
        ...(genre && { genre }),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    enabled: Boolean(id),
  });

  const set = (changes: Record<string, string>) =>
    router.setParams({ id, sort, genre, ...changes });

  if (libraries.isPending) return <Loading />;
  if (libraries.isError)
    return <ErrorView error={libraries.error} onRetry={() => void libraries.refetch()} />;

  const loaded = items.data?.pages.flatMap((p) => p.items) ?? [];
  const total = items.data?.pages[0]?.total ?? 0;

  const header = (
    <View style={{ gap: 14, marginBottom: 14 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {all.map((l) => (
          <Chip
            key={l.id}
            label={label(l, all)}
            on={l.id === id}
            onPress={() => set({ id: l.id, genre: '' })}
          />
        ))}
      </ScrollView>
      <View style={styles.tools}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setPicking('sort')}
          style={styles.select}
        >
          <Text style={styles.selectText}>{SORTS.find((s) => s.id === sort)?.label}</Text>
          <Icon name="chevronDown" size={18} color={colors.text2} />
        </Pressable>
        {(genres.data?.length ?? 0) > 0 && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setPicking('genre')}
            style={styles.select}
          >
            <Text style={styles.selectText} numberOfLines={1}>
              {genre || 'Alle genres'}
            </Text>
            <Icon name="chevronDown" size={18} color={colors.text2} />
          </Pressable>
        )}
      </View>
      {items.data && <Text style={text.small}>{countLabel(total, 'titel', 'titels')}</Text>}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Text style={[text.h1, styles.title]}>{library ? label(library, all) : 'Bibliotheek'}</Text>
      {items.isError ? (
        <ErrorView error={items.error} onRetry={() => void items.refetch()} />
      ) : (
        <FlatList
          key={columns}
          data={loaded}
          numColumns={columns}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: 24, gap: 16 }}
          ListHeaderComponent={header}
          ListEmptyComponent={
            items.isPending ? (
              <ActivityIndicator color={colors.brass} style={{ marginTop: 40 }} />
            ) : (
              <Text style={text.muted}>Niets gevonden.</Text>
            )
          }
          onEndReachedThreshold={0.8}
          onEndReached={() => {
            if (items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
          }}
          ListFooterComponent={
            items.isFetchingNextPage ? <ActivityIndicator color={colors.brass} /> : undefined
          }
        />
      )}
      {picking === 'sort' && (
        <Picker
          title="Sorteren"
          options={SORTS}
          value={sort}
          onChange={(value) => set({ sort: value })}
          onClose={() => setPicking(undefined)}
        />
      )}
      {picking === 'genre' && (
        <Picker
          title="Genre"
          options={[
            { id: '', label: 'Alle genres' },
            ...(genres.data ?? []).map((g) => ({ id: g, label: g })),
          ]}
          value={genre}
          onChange={(value) => set({ genre: value })}
          onClose={() => setPicking(undefined)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: gutter, paddingTop: 12, paddingBottom: 12 },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  chipOn: { backgroundColor: colors.brass, borderColor: colors.brass },
  chipText: { fontSize: 14, color: colors.text, fontWeight: '700' },
  tools: { flexDirection: 'row', gap: 8 },
  select: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: radius.s,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  selectText: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.surface2,
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    padding: 20,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 12,
    borderRadius: radius.s,
  },
});

// The TV has its own screens, for the remote.
export default isTV ? TvLibrary : LibraryScreen;
