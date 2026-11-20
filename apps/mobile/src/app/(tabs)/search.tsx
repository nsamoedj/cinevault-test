import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../components/Icon';
import { useGrid } from '../../components/sizes';
import { Button, ErrorView, PosterCard, text } from '../../components/ui';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors, gutter, radius } from '../../theme';
import { isTV } from '../../tv/focus';
import { TvSearch } from '../../tv/screens/TvSearch';

/** Search every library at once. */
function SearchScreen() {
  const { api, user } = useSession();
  const kids = user?.maxAge !== undefined;
  const { columns, cardWidth, gap } = useGrid();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const results = useQuery({
    queryKey: keys.search(query),
    queryFn: () => api.search(query),
    enabled: query.length > 0,
    placeholderData: (previous) => previous,
  });

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.field}>
        <Icon name="search" size={22} color={colors.text3} />
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Films, series en anime"
          placeholderTextColor={colors.text3}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Zoeken in alle bibliotheken"
        />
        {results.isFetching && <ActivityIndicator color={colors.brass} />}
      </View>
      {!query ? (
        <View style={styles.empty}>
          <Icon name="search" size={44} color={colors.text3} />
          <Text style={[text.muted, { textAlign: 'center' }]}>
            Zoek op titel, in alle bibliotheken tegelijk.
          </Text>
        </View>
      ) : results.isError ? (
        <ErrorView error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <FlatList
          key={columns}
          data={results.data ?? []}
          numColumns={columns}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: 24, gap: 16 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListEmptyComponent={
            results.data ? (
              <Text style={text.muted}>Niets gevonden voor “{query}”.</Text>
            ) : undefined
          }
          ListFooterComponent={
            results.data && !kids ? (
              <Button
                label="Staat het er niet tussen? Aanvragen"
                icon="plus"
                kind="secondary"
                onPress={() => router.push({ pathname: '/discover', params: { q: query } })}
              />
            ) : undefined
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 32 },
});

// The TV has its own screens, for the remote.
export default isTV ? TvSearch : SearchScreen;
