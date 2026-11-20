import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useGrid } from '../components/sizes';
import { ErrorView, IconButton, Loading, PosterCard, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, gutter } from '../theme';

/** "Mijn lijst": what the profile keeps to watch, the last added first. */
export default function MyListScreen() {
  const { api } = useSession();
  const { columns, cardWidth, gap } = useGrid();
  const list = useQuery({ queryKey: keys.myList, queryFn: api.myList });
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.head}>
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <Text style={text.h1}>Mijn lijst</Text>
      </View>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Text style={[text.muted, { padding: gutter }]}>
          Nog niets bewaard. Kies Mijn lijst bij een film of serie. Van series in je lijst krijg je
          een melding als er een nieuwe aflevering is.
        </Text>
      ) : (
        <FlatList
          data={list.data}
          key={columns}
          numColumns={columns}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={{ gap }}
          renderItem={({ item }) => <PosterCard item={item} width={cardWidth} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  grid: { padding: gutter, gap: 16, paddingBottom: 32 },
});
