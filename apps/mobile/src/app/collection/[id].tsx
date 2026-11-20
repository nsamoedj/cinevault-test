import { collectionLabel } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGrid } from '../../components/sizes';
import {
  Button,
  ErrorView,
  IconButton,
  Loading,
  MissingPartCard,
  PosterCard,
  ServerImage,
  text,
} from '../../components/ui';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors, gutter } from '../../theme';
import { isTV } from '../../tv/focus';
import { TvCollection } from '../../tv/screens/TvCollection';

/** One collection: all its films in the order they came out, also the ones not here. */
function CollectionScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { api, user } = useSession();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { columns, cardWidth, gap } = useGrid();
  const collection = useQuery({
    queryKey: keys.collection(Number(id)),
    queryFn: () => api.collection(Number(id)),
  });
  const back = (
    <View style={[styles.back, { top: insets.top + 4 }]}>
      <IconButton icon="back" label="Terug" onPress={() => router.back()} />
    </View>
  );
  if (collection.isPending) return <Loading />;
  if (collection.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 48 }}>
        {back}
        <ErrorView error={collection.error} onRetry={() => void collection.refetch()} />
      </View>
    );
  }
  const data = collection.data;
  const next = data.next;
  const canAsk = user?.maxAge === undefined;
  const backdropHeight = Math.min(360, (width * 9) / 16);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={data.parts}
        key={columns}
        numColumns={columns}
        keyExtractor={(part) => String(part.tmdbId)}
        columnWrapperStyle={{ gap }}
        contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 32 }]}
        renderItem={({ item: part }) =>
          part.item ? (
            <PosterCard item={part.item} width={cardWidth} />
          ) : (
            <MissingPartCard part={part} width={cardWidth} canAsk={canAsk} />
          )
        }
        ListHeaderComponent={
          <View style={{ marginHorizontal: -gutter }}>
            <View style={{ height: backdropHeight }}>
              <ServerImage
                path={data.backdropUrl ?? data.posterUrl}
                style={StyleSheet.absoluteFill}
                fallback={data.name}
              />
              <LinearGradient
                colors={['rgba(10,18,48,0.1)', 'rgba(10,18,48,0.4)', colors.bg]}
                locations={[0, 0.55, 1]}
                style={StyleSheet.absoluteFill}
              />
            </View>
            <View style={styles.info}>
              <Text style={text.h1} accessibilityRole="header">
                {data.name}
              </Text>
              <Text style={text.muted}>{collectionLabel(data)}</Text>
              {next && (
                <Button
                  label={data.watched > 0 ? `Verder met ${next.title}` : `Begin met ${next.title}`}
                  icon="play"
                  onPress={() => router.push(`/item/${next.id}`)}
                />
              )}
              {data.overview ? <Text style={text.body}>{data.overview}</Text> : null}
            </View>
          </View>
        }
      />
      {back}
    </View>
  );
}

export default isTV ? TvCollection : CollectionScreen;

const styles = StyleSheet.create({
  back: { position: 'absolute', left: 8 },
  info: { paddingHorizontal: gutter, gap: 10, marginTop: -40, marginBottom: 20 },
  grid: { paddingHorizontal: gutter, gap: 16 },
});
