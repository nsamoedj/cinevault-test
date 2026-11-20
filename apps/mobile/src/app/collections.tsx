import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useGrid } from '../components/sizes';
import { CollectionCard, ErrorView, IconButton, Loading, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, gutter } from '../theme';

/** "Collecties": the film collections with two films or more in the library. */
export default function CollectionsScreen() {
  const { api } = useSession();
  // Wide cards: one column on a phone, more on a tablet.
  const { columns, cardWidth, gap } = useGrid(280, 1);
  const list = useQuery({ queryKey: keys.collections, queryFn: api.collections });
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.head}>
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <Text style={text.h1}>Collecties</Text>
      </View>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Text style={[text.muted, { padding: gutter }]}>
          Nog geen collecties. Een filmreeks verschijnt hier zodra er twee films van in de
          bibliotheek staan.
        </Text>
      ) : (
        <FlatList
          data={list.data}
          key={columns}
          numColumns={columns}
          keyExtractor={(collection) => String(collection.id)}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={columns > 1 ? { gap } : undefined}
          renderItem={({ item }) => <CollectionCard collection={item} width={cardWidth} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  grid: { padding: gutter, gap: 16, paddingBottom: 32 },
});
