// Search on the TV: the field opens the TV's keyboard (or the phone's, through
// the Google TV app), the results are a grid.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { Icon } from '../../components/Icon';
import { ErrorView } from '../../components/ui';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors, radius } from '../../theme';
import { FocusMemory } from '../focus';
import { createSpotStore, itemSpot, SpotThemeMusic } from '../spotlight';
import { CARD_GAP, TV_GUTTER, TvPosterCard, tvText, useTvSizes } from '../ui';

const COLUMNS = 6;

export function TvSearch() {
  const { api } = useSession();
  const { inner } = useTvSizes();
  const cardWidth = Math.floor((inner - CARD_GAP * (COLUMNS - 1)) / COLUMNS);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [store] = useState(() => createSpotStore());

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 400);
    return () => clearTimeout(timer);
  }, [input]);

  const results = useQuery({
    queryKey: keys.search(query),
    queryFn: () => api.search(query),
    enabled: query.length > 0,
    placeholderData: (previous) => previous,
  });

  const field = (
    <View style={styles.header}>
      <Text style={tvText.h1}>Zoeken</Text>
      <View style={[styles.field, editing && styles.fieldFocused]}>
        <Icon name="search" size={24} color={editing ? colors.brass : colors.text3} />
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          placeholder="Films, series en anime"
          placeholderTextColor={colors.text3}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Zoeken in alle bibliotheken"
        />
        {results.isFetching && <ActivityIndicator color={colors.brass} />}
      </View>
    </View>
  );

  return (
    <FocusMemory>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <SpotThemeMusic store={store} />
        {results.isError ? (
          <>
            {field}
            <ErrorView error={results.error} onRetry={() => void results.refetch()} />
          </>
        ) : (
          <FlatList
            data={query ? (results.data ?? []) : []}
            numColumns={COLUMNS}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TvPosterCard
                item={item}
                width={cardWidth}
                titled
                onFocus={() => store.set(itemSpot(item))}
              />
            )}
            columnWrapperStyle={{ gap: CARD_GAP }}
            contentContainerStyle={styles.grid}
            ListHeaderComponent={field}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text style={tvText.muted}>
                {!query
                  ? 'Zoek op titel, in alle bibliotheken tegelijk. Druk op OK om te typen.'
                  : results.data
                    ? `Niets gevonden voor “${query}”.`
                    : ''}
              </Text>
            }
            removeClippedSubviews={false}
          />
        )}
      </View>
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  header: { gap: 16, paddingTop: 32, marginBottom: 12 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    minHeight: 56,
    maxWidth: 640,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.line,
  },
  fieldFocused: { borderColor: colors.brass },
  input: { flex: 1, color: colors.text, fontSize: 20 },
  grid: { paddingHorizontal: TV_GUTTER, paddingBottom: 40, gap: 22 },
});
