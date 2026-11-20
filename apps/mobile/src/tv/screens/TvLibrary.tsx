// A library on the TV (Films, Series or Anime, chosen in the side menu): a
// fixed header that shows the focused title, with the sort order and the
// genre as two buttons, above a grid of posters that loads more as the focus
// goes down. Sort and genre open a list on the right; back closes it.

import type { ItemSort, ItemSummary } from '@cinevault/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { type Ref, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  findNodeHandle,
  FlatList,
  type HostInstance,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Icon } from '../../components/Icon';
import { ErrorView, Loading, ServerImage } from '../../components/ui';
import { countLabel, libraryLabel } from '../../format';
import { keys } from '../../keys';
import { useBrowseThemeMusic } from '../../themeMusic';
import { useSession } from '../../session';
import { colors, radius } from '../../theme';
import { FocusMemory, focusLater, TvPressable } from '../focus';
import { TV_GUTTER, TvButton, TvPosterCard, tvText, useTvSizes } from '../ui';

const PAGE_SIZE = 60;
const COLUMNS = 6;
const GAP = 16;
// Room for the title, its facts and two lines of description above the grid.
const HEADER_HEIGHT = 206;
/** The backdrop follows the focus after this pause, not on every step. */
const BACKDROP_DELAY_MS = 350;

const SORTS: { id: ItemSort; label: string }[] = [
  { id: 'title', label: 'A-Z' },
  { id: 'added', label: 'Nieuw toegevoegd' },
  { id: 'year', label: 'Jaar' },
  { id: 'rating', label: 'Waardering' },
];

/** The focused poster, outside React state: only the header follows it, not the grid. */
function createFocusStore() {
  let value: ItemSummary | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: ItemSummary | undefined) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
type FocusStore = ReturnType<typeof createFocusStore>;

/** The theme music of the poster with the focus (renders nothing). */
function FocusThemeMusic({ store }: { store: FocusStore }) {
  useBrowseThemeMusic(useSyncExternalStore(store.subscribe, store.get)?.id);
  return null;
}

function facts(item: ItemSummary): string {
  return [
    item.year ? String(item.year) : '',
    item.rating ? `★ ${item.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}` : '',
    (item.genres ?? []).slice(0, 3).join(', '),
  ]
    .filter(Boolean)
    .join('   ·   ');
}

/** The focused title: its backdrop faintly on the right, its name, facts and description. */
function Spotlight({ store, fallback }: { store: FocusStore; fallback?: ItemSummary }) {
  const item = useSyncExternalStore(store.subscribe, store.get) ?? fallback;
  const [backdrop, setBackdrop] = useState(item?.backdropUrl);
  useEffect(() => {
    const timer = setTimeout(() => setBackdrop(item?.backdropUrl), BACKDROP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [item?.backdropUrl]);

  return (
    <>
      <View style={styles.backdrop} pointerEvents="none">
        {backdrop && <ServerImage path={backdrop} style={StyleSheet.absoluteFill} />}
        <LinearGradient
          colors={[colors.bg, 'rgba(10,18,48,0.72)', 'rgba(10,18,48,0.35)']}
          locations={[0, 0.45, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={['rgba(10,18,48,0)', colors.bg]}
          locations={[0.45, 1]}
          style={StyleSheet.absoluteFill}
        />
      </View>
      {item && (
        <View style={styles.spotlight}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          {facts(item) ? <Text style={styles.facts}>{facts(item)}</Text> : null}
          {item.overview ? (
            <Text style={styles.overview} numberOfLines={2}>
              {item.overview}
            </Text>
          ) : null}
        </View>
      )}
    </>
  );
}

/** "Sorteren: A-Z": a button that opens the list of choices. */
function SelectButton({
  label,
  value,
  onPress,
  ref,
  focusable,
}: {
  label: string;
  value: string;
  onPress: () => void;
  ref?: Ref<HostInstance | null>;
  focusable: boolean;
}) {
  return (
    <TvPressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      focusable={focusable}
      style={styles.select}
      focusStyle={styles.selectFocused}
    >
      {({ focused }) => (
        <>
          <Text style={[styles.selectLabel, focused && { color: colors.ink }]}>{label}</Text>
          <Text style={[styles.selectValue, focused && { color: colors.ink }]} numberOfLines={1}>
            {value}
          </Text>
          <Icon name="chevronDown" size={18} color={focused ? colors.ink : colors.text2} />
        </>
      )}
    </TvPressable>
  );
}

/** One choice in the list; left, right and the ends keep the focus in the list. */
function Option({
  label,
  on,
  first,
  last,
  onPress,
}: {
  label: string;
  on: boolean;
  first: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const view = useRef<HostInstance | null>(null);
  const [tag, setTag] = useState<number>();
  return (
    <TvPressable
      ref={view}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      autoFocus={on}
      onLayout={() => setTag(findNodeHandle(view.current) ?? undefined)}
      {...(tag !== undefined && {
        nextFocusLeft: tag,
        nextFocusRight: tag,
        ...(first && { nextFocusUp: tag }),
        ...(last && { nextFocusDown: tag }),
      })}
      style={[styles.option, on && styles.optionOn]}
      focusStyle={styles.optionFocused}
    >
      {({ focused }) => (
        <>
          <Text
            style={[
              styles.optionText,
              on && { color: colors.brass },
              focused && { color: colors.ink },
            ]}
            numberOfLines={1}
          >
            {label}
          </Text>
          {on && <Icon name="check" size={20} color={focused ? colors.ink : colors.brass} />}
        </>
      )}
    </TvPressable>
  );
}

function Picker({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.pickerLayer}>
      <View style={styles.scrim} />
      <View style={styles.picker}>
        <Text style={tvText.h2}>{title}</Text>
        <ScrollView contentContainerStyle={{ gap: 4, paddingVertical: 8 }}>
          {options.map((option, index) => (
            <Option
              key={option.id || 'all'}
              label={option.label}
              on={option.id === value}
              first={index === 0}
              last={index === options.length - 1}
              onPress={() => onChange(option.id)}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

export function TvLibrary() {
  const { api } = useSession();
  const params = useLocalSearchParams<{ id?: string; sort?: string; genre?: string }>();
  const { inner } = useTvSizes();
  const cardWidth = Math.floor((inner - GAP * (COLUMNS - 1)) / COLUMNS);
  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const all = libraries.data ?? [];
  const library = all.find((l) => l.id === params.id) ?? all[0];
  const id = library?.id ?? '';
  const sort = (SORTS.find((s) => s.id === params.sort)?.id ?? 'title') as ItemSort;
  const genre = params.genre ?? '';
  const listKey = `${id}/${sort}/${genre}`;

  const [picking, setPicking] = useState<'sort' | 'genre'>();
  // After a new order or genre the focus goes back to its button; after a
  // new library (from the menu) to the first poster.
  const [quietList, setQuietList] = useState<string>();
  const [store] = useState(createFocusStore);
  const sortButton = useRef<HostInstance | null>(null);
  const genreButton = useRef<HostInstance | null>(null);

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

  useEffect(() => store.set(undefined), [listKey, store]);

  const close = (which: 'sort' | 'genre') => {
    setPicking(undefined);
    focusLater((which === 'sort' ? sortButton : genreButton).current);
  };

  useEffect(() => {
    if (!picking) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close(picking);
      return true;
    });
    return () => subscription.remove();
  });

  const choose = (which: 'sort' | 'genre', value: string) => {
    const next = which === 'sort' ? { sort: value, genre } : { sort, genre: value };
    setQuietList(`${id}/${next.sort}/${next.genre}`);
    router.setParams({ id, ...next });
    close(which);
  };

  if (libraries.isPending) return <Loading />;
  if (libraries.isError)
    return <ErrorView error={libraries.error} onRetry={() => void libraries.refetch()} />;

  const loaded = items.data?.pages.flatMap((p) => p.items) ?? [];
  const total = items.data?.pages[0]?.total;
  const name = library ? libraryLabel(library, all) : 'Bibliotheek';
  const open = Boolean(picking);
  const eyebrow = [
    name,
    genre,
    total !== undefined ? countLabel(total, 'titel', 'titels') : '',
  ].filter(Boolean);

  return (
    <FocusMemory>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={styles.header}>
          <Spotlight key={listKey} store={store} fallback={loaded[0]} />
          <FocusThemeMusic store={store} />
          <View style={styles.headerTop}>
            <Text style={tvText.eyebrow} numberOfLines={1}>
              {eyebrow.join('  ·  ')}
            </Text>
            <View style={styles.selects}>
              <SelectButton
                ref={sortButton}
                label="Sorteren"
                value={SORTS.find((s) => s.id === sort)?.label ?? ''}
                onPress={() => setPicking('sort')}
                focusable={!open}
              />
              {(genres.data?.length ?? 0) > 0 && (
                <SelectButton
                  ref={genreButton}
                  label="Genre"
                  value={genre || 'Alle'}
                  onPress={() => setPicking('genre')}
                  focusable={!open}
                />
              )}
            </View>
          </View>
        </View>

        {items.isError ? (
          <ErrorView error={items.error} onRetry={() => void items.refetch()} />
        ) : (
          <FlatList
            key={listKey}
            data={loaded}
            numColumns={COLUMNS}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <TvPosterCard
                item={item}
                width={cardWidth}
                autoFocus={index === 0 && quietList !== listKey}
                onFocus={() => store.set(item)}
                focusable={!open}
              />
            )}
            extraData={open}
            columnWrapperStyle={{ gap: GAP }}
            contentContainerStyle={styles.grid}
            ListEmptyComponent={
              items.isPending ? (
                <ActivityIndicator color={colors.brass} style={{ marginTop: 40 }} />
              ) : (
                <View style={styles.empty}>
                  <Text style={tvText.muted}>
                    {genre ? `Geen titels in het genre ${genre}.` : 'Deze bibliotheek is leeg.'}
                  </Text>
                  {genre ? (
                    <TvButton
                      label="Alle genres"
                      autoFocus
                      onPress={() => router.setParams({ id, sort, genre: '' })}
                    />
                  ) : null}
                </View>
              )
            }
            onEndReachedThreshold={1.5}
            onEndReached={() => {
              if (items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
            }}
            ListFooterComponent={
              items.isFetchingNextPage ? (
                <ActivityIndicator color={colors.brass} style={{ marginTop: 12 }} />
              ) : undefined
            }
            removeClippedSubviews={false}
          />
        )}

        {picking === 'sort' && (
          <Picker
            title="Sorteren"
            options={SORTS}
            value={sort}
            onChange={(value) => choose('sort', value)}
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
            onChange={(value) => choose('genre', value)}
          />
        )}
      </View>
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  header: {
    height: HEADER_HEIGHT,
    paddingHorizontal: TV_GUTTER,
    overflow: 'hidden',
  },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, width: '62%' },
  headerTop: {
    position: 'absolute',
    top: 18,
    left: TV_GUTTER,
    right: TV_GUTTER,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 24,
  },
  selects: { flexDirection: 'row', gap: 12 },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 42,
    paddingHorizontal: 16,
    borderRadius: radius.s,
    backgroundColor: 'rgba(10,18,48,0.6)',
    borderWidth: 2,
    borderColor: colors.lineStrong,
  },
  selectFocused: {
    backgroundColor: colors.brass,
    borderColor: colors.brass,
    transform: [{ scale: 1.05 }],
  },
  selectLabel: { color: colors.text3, fontSize: 15, fontWeight: '600' },
  selectValue: { color: colors.text, fontSize: 15, fontWeight: '800', maxWidth: 180 },
  spotlight: { marginTop: 70, maxWidth: '62%', gap: 4 },
  title: { color: colors.text, fontSize: 30, fontWeight: '900', letterSpacing: -0.3 },
  facts: { color: colors.text2, fontSize: 15, fontWeight: '600' },
  overview: { color: colors.text2, fontSize: 15, lineHeight: 21, marginTop: 2 },
  grid: { paddingHorizontal: TV_GUTTER - 3, paddingTop: 10, paddingBottom: 40, gap: 18 },
  empty: { gap: 16, alignItems: 'flex-start', paddingTop: 24, paddingHorizontal: 3 },
  pickerLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row' },
  scrim: { flex: 1, backgroundColor: colors.scrim },
  picker: {
    width: 380,
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 16,
    gap: 10,
    backgroundColor: 'rgba(10,18,48,0.98)',
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: radius.s,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionOn: { backgroundColor: colors.brassSoft },
  optionFocused: { backgroundColor: colors.brass, borderColor: colors.brass },
  optionText: { color: colors.text, fontSize: 18, fontWeight: '700', flexShrink: 1 },
});
