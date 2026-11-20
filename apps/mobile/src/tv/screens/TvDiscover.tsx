// "Ontdekken" on the TV, laid out like the start page: at the top the search
// (the TV's keyboard, or the phone's through the Google TV app) and the
// requests; below, rows of new titles, with the focused one in the header.
// Each row ends in "Alles bekijken". OK on a poster opens it.

import type { DiscoverItem } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { type ComponentRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  findNodeHandle,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Icon } from '../../components/Icon';
import { ErrorView, Loading } from '../../components/ui';
import { useSession } from '../../session';
import { colors, radius } from '../../theme';
import { type BrowseRow, TvBrowse } from '../Browse';
import { TvDiscoverCard } from '../discover';
import { FocusMemory, FocusScale, noFocusStyle, TvPressable } from '../focus';
import { HeroBackdrop, HeroInfo } from '../Hero';
import { createSpotStore, discoverSpot, SpotThemeMusic } from '../spotlight';
import { CARD_GAP, TV_GUTTER, TvButton, TvRow, tvText, useTvSizes } from '../ui';

const COLUMNS = 6;

type Cell = { item: DiscoverItem } | { more: string };

/** The last card of a row: the whole row as a grid. */
function MoreCard({
  rowId,
  width,
  onFocus,
}: {
  rowId: string;
  width: number;
  onFocus: () => void;
}) {
  return (
    <TvPressable
      accessibilityRole="link"
      accessibilityLabel="Alles bekijken"
      onPress={() => router.push({ pathname: '/discover-row', params: { id: rowId } })}
      onFocus={onFocus}
      focusStyle={noFocusStyle}
      style={{ width }}
    >
      {({ focused }) => (
        <FocusScale
          focused={focused}
          style={[styles.more, { height: Math.round(width * 1.5) }, focused && styles.moreFocused]}
        >
          <Icon name="chevronRight" size={32} color={focused ? colors.ink : colors.text} />
          <Text style={[styles.moreText, focused && { color: colors.ink }]}>Alles bekijken</Text>
        </FocusScale>
      )}
    </TvPressable>
  );
}

function SearchField({
  value,
  onChange,
  busy,
  onFocus,
  label,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onFocus?: () => void;
  label: string;
  placeholder: string;
}) {
  const [editing, setEditing] = useState(false);
  // "Up" stays in the field: above it there is only the menu.
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  const [own, setOwn] = useState<number>();
  useEffect(() => setOwn(findNodeHandle(field.current) ?? undefined), []);
  return (
    <View style={[styles.field, editing && styles.fieldFocused]}>
      <Icon name="search" size={24} color={editing ? colors.brass : colors.text3} />
      <TextInput
        ref={field}
        {...(own !== undefined && { nextFocusUp: own })}
        style={styles.input}
        value={value}
        onChangeText={onChange}
        onFocus={() => {
          setEditing(true);
          onFocus?.();
        }}
        onBlur={() => setEditing(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.text3}
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={label}
      />
      {busy && <ActivityIndicator color={colors.brass} />}
    </View>
  );
}

export function TvDiscover() {
  const { api } = useSession();
  const { poster, inner } = useTvSizes();
  const cardWidth = Math.floor((inner - CARD_GAP * (COLUMNS - 1)) / COLUMNS);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [store] = useState(() => createSpotStore());
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 500);
    return () => clearTimeout(timer);
  }, [input]);
  const feed = useQuery({ queryKey: ['discover', 'feed'], queryFn: api.discover });
  const results = useQuery({
    queryKey: ['discover', 'search', query, 'tv'],
    queryFn: () => api.discoverSearch(query),
    enabled: query.length > 0,
    placeholderData: (previous) => previous,
  });

  // The first title of the feed until the focus is on one.
  const first = feed.data?.rows[0]?.items[0];
  useEffect(() => {
    if (first && !store.get()) store.set(discoverSpot(first));
  }, [first, store]);

  const rows = useMemo<BrowseRow[]>(
    () =>
      (feed.data?.rows ?? []).map((row) => ({
        key: row.id,
        render: ({ hidden, onFocus }) => (
          <TvRow<Cell>
            title={row.title}
            data={[...row.items.map((item) => ({ item })), { more: row.id }]}
            keyOf={(cell) => ('item' in cell ? `${cell.item.kind}-${cell.item.tmdbId}` : 'more')}
            itemWidth={poster}
            hidden={hidden}
            onFocus={(cell) => {
              onFocus();
              if ('item' in cell) store.set(discoverSpot(cell.item));
            }}
            render={(cell, _index, focus) =>
              'item' in cell ? (
                <TvDiscoverCard item={cell.item} width={poster} onFocus={focus} />
              ) : (
                <MoreCard rowId={cell.more} width={poster} onFocus={focus} />
              )
            }
          />
        ),
      })),
    [feed.data, poster, store],
  );

  const top = useMemo(
    () => (onFocus: () => void) => (
      <View style={styles.top}>
        <Text style={tvText.eyebrow}>Nieuwe films en series</Text>
        <Text style={styles.title}>Ontdekken</Text>
        <Text style={tvText.muted} numberOfLines={2}>
          Zoek een titel of blader door wat er nieuw is. Staat het er nog niet, vraag het dan aan.
        </Text>
        <View style={styles.topRow}>
          <SearchField
            value={input}
            onChange={setInput}
            busy={results.isFetching}
            onFocus={onFocus}
            label="Zoeken bij TMDB"
            placeholder="Zoek een film of serie"
          />
          <TvButton
            label="Verzoeken"
            icon="sparkle"
            lastInLine
            onFocus={onFocus}
            onPress={() => router.push('/requests')}
          />
        </View>
      </View>
    ),
    // The field's text is part of it.
    [input, results.isFetching],
  );

  if (query) {
    return (
      <FocusMemory>
        <FlatList
          style={{ flex: 1, backgroundColor: colors.bg }}
          data={results.data?.items ?? []}
          numColumns={COLUMNS}
          keyExtractor={(item) => `${item.kind}-${item.tmdbId}`}
          renderItem={({ item }) => <TvDiscoverCard item={item} width={cardWidth} titled />}
          columnWrapperStyle={{ gap: CARD_GAP }}
          contentContainerStyle={styles.grid}
          ListHeaderComponent={
            <View style={styles.searchHeader}>
              <Text style={tvText.h1}>Ontdekken</Text>
              <SearchField
                value={input}
                onChange={setInput}
                busy={results.isFetching}
                label="Zoeken bij TMDB"
                placeholder="Zoek een film of serie"
              />
            </View>
          }
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={tvText.muted}>{results.data ? 'Niets gevonden bij TMDB.' : ''}</Text>
          }
          removeClippedSubviews={false}
        />
      </FocusMemory>
    );
  }

  if (feed.isPending) return <Loading />;
  if (feed.isError) return <ErrorView error={feed.error} onRetry={() => void feed.refetch()} />;

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
  top: { gap: 10, paddingBottom: 8 },
  title: { color: colors.text, fontSize: 44, fontWeight: '900', letterSpacing: -0.6 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  searchHeader: { gap: 16, paddingTop: 32, marginBottom: 12 },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    minHeight: 52,
    maxWidth: 560,
    borderRadius: radius.m,
    backgroundColor: 'rgba(20,34,73,0.85)',
    borderWidth: 2,
    borderColor: colors.line,
  },
  fieldFocused: { borderColor: colors.brass },
  input: { flex: 1, color: colors.text, fontSize: 19 },
  grid: { paddingHorizontal: TV_GUTTER, paddingBottom: 40, gap: 22 },
  more: {
    borderRadius: radius.m,
    borderWidth: 2,
    borderColor: colors.lineStrong,
    backgroundColor: 'rgba(20,34,73,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  moreFocused: { backgroundColor: colors.brass, borderColor: colors.brass },
  moreText: { color: colors.text, fontSize: 15, fontWeight: '800' },
});
