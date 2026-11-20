import {
  type DiscoverDetails,
  discoverPartLabel,
  type MediaRequestDto,
  type RequestKind,
  trailerUrl,
} from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  ErrorView,
  IconButton,
  Loading,
  Rail,
  ServerImage,
  errorText,
  text,
} from '../components/ui';
import { CastRail } from '../components/CastRail';
import { DiscoverCard } from '../components/DiscoverCard';
import { Icon } from '../components/Icon';
import { useCardWidths } from '../components/sizes';
import { DownloadLine } from '../components/Download';
import { SeasonPicker } from '../components/SeasonPicker';
import { kindLabel, releaseLine, STATUS_COLOR, STATUS_LABEL, useAskFor } from '../discover';
import { runtimeLabel } from '../format';
import { useSession } from '../session';
import { colors, gutter, radius } from '../theme';
import { isTV } from '../tv/focus';
import { TvDiscoverTitle } from '../tv/screens/TvDiscoverTitle';

/** What happens now with a request just made. */
function askedMessage(request: MediaRequestDto): string {
  if (request.status === 'PENDING') {
    return 'Aangevraagd. Je krijgt een melding als een beheerder het goedkeurt.';
  }
  if (request.status === 'APPROVED') return 'Aangevraagd. Het wordt nu gezocht.';
  return request.reason ?? '';
}

/** The film's collection, in order: this one marked, the others open their page. */
function CollectionRail({ details }: { details: DiscoverDetails }) {
  const { poster } = useCardWidths();
  const collection = details.collection;
  if (!collection) return null;
  return (
    <Rail
      title={collection.name}
      data={collection.parts}
      keyOf={(part) => String(part.tmdbId)}
      render={(part) => {
        const current = part.tmdbId === details.tmdbId;
        return (
          <DiscoverCard
            item={part}
            width={poster}
            sub={discoverPartLabel(part, current)}
            current={current}
          />
        );
      }}
      action={
        // Films of it in the library: the collection's page there.
        collection.owned > 0 ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`${collection.name} in de bibliotheek`}
            hitSlop={8}
            onPress={() => router.push(`/collection/${collection.id}`)}
            style={styles.more}
          >
            <Text style={styles.moreText}>In bibliotheek</Text>
            <Icon name="chevronRight" size={16} color={colors.text2} />
          </Pressable>
        ) : undefined
      }
    />
  );
}

/** "Meer zoals dit": TMDB's recommendations, each opens its own page. */
function SimilarRail({ details }: { details: DiscoverDetails }) {
  const { poster } = useCardWidths();
  if (!details.similar || details.similar.length === 0) return null;
  return (
    <Rail
      title="Meer zoals dit"
      data={details.similar}
      keyOf={(item) => `${item.kind}-${item.tmdbId}`}
      render={(item) => <DiscoverCard item={item} width={poster} />}
    />
  );
}

/** A title from "Ontdekken": what it is, the trailer, the cast, and "Aanvragen". */
function DiscoverTitleScreen() {
  const params = useLocalSearchParams<{ kind: RequestKind; id: string }>();
  const kind: RequestKind = params.kind === 'show' ? 'show' : 'movie';
  const tmdbId = Number(params.id);
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const details = useQuery({
    queryKey: ['discover', 'details', kind, tmdbId],
    queryFn: () => api.discoverDetails(kind, tmdbId),
    refetchInterval: (query) => (query.state.data?.download ? 15_000 : false),
  });
  const ask = useAskFor({ kind, tmdbId, title: '', anime: details.data?.anime ?? false });
  // A part of the show asked for (SeasonPicker).
  const [partAsked, setPartAsked] = useState<MediaRequestDto>();

  const back = (
    <IconButton
      icon="back"
      label="Terug"
      onPress={() => router.back()}
      style={{ position: 'absolute', top: insets.top + 6, left: 8, backgroundColor: colors.scrim }}
    />
  );
  if (details.isPending) return <Loading />;
  if (details.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorView error={details.error} onRetry={() => void details.refetch()} />
        {back}
      </View>
    );
  }
  const data = details.data;
  const status = ask.data?.status ?? data.request?.status;
  const facts = [
    data.rating ? `★ ${data.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}` : '',
    data.year ? String(data.year) : '',
    kindLabel(data),
    data.kind === 'movie' ? runtimeLabel(data.runtimeMinutes) : '',
    data.seasons ? `${data.seasons} ${data.seasons === 1 ? 'seizoen' : 'seizoenen'}` : '',
  ].filter(Boolean);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <View style={{ height: Math.min(420, (width * 9) / 16 + 60) }}>
          <ServerImage path={data.backdropUrl ?? data.posterUrl} style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={['rgba(10,18,48,0.5)', 'rgba(10,18,48,0)', colors.bg]}
            locations={[0, 0.35, 1]}
            style={StyleSheet.absoluteFill}
          />
        </View>
        <View style={styles.info}>
          <View style={styles.titleRow}>
            <ServerImage path={data.posterUrl} style={styles.poster} fallback={data.title} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.title}>{data.title}</Text>
              <Text style={styles.facts}>{facts.join('  ·  ')}</Text>
            </View>
          </View>
          {data.genres.length > 0 && <Text style={text.muted}>{data.genres.join(' · ')}</Text>}
          {releaseLine(data) && <Text style={text.small}>{releaseLine(data)}</Text>}
          {data.download && <DownloadLine download={data.download} large />}
          {data.itemId ? (
            <Button
              label="In de bibliotheek"
              icon="play"
              onPress={() => router.push(`/item/${data.itemId}`)}
            />
          ) : status && status !== 'DECLINED' ? (
            <View style={styles.status}>
              <Text style={[styles.statusText, { color: STATUS_COLOR[status] }]}>
                {STATUS_LABEL[status]}
              </Text>
            </View>
          ) : (
            <Button
              label={
                status === 'DECLINED'
                  ? 'Opnieuw aanvragen'
                  : data.kind === 'show'
                    ? 'Hele serie aanvragen'
                    : 'Aanvragen'
              }
              icon="plus"
              disabled={ask.isPending}
              onPress={() => ask.mutate()}
            />
          )}
          {ask.isSuccess && <Text style={text.muted}>{askedMessage(ask.data)}</Text>}
          {ask.isError && <Text style={styles.error}>{errorText(ask.error)}</Text>}
          {data.trailerKey && (
            <Button
              label="Trailer"
              icon="film"
              kind="glass"
              onPress={() =>
                void Linking.openURL(trailerUrl(data.trailerKey ?? '')).catch(() => {})
              }
            />
          )}
          {data.tagline ? (
            <Text style={[text.muted, { fontStyle: 'italic' }]}>{data.tagline}</Text>
          ) : null}
          {data.overview ? <Text style={text.body}>{data.overview}</Text> : null}
          {data.kind === 'show' &&
            status !== 'PENDING' &&
            status !== 'APPROVED' &&
            data.seasonList &&
            data.seasonList.length > 0 && (
              <SeasonPicker item={data} seasons={data.seasonList} onAsked={setPartAsked} />
            )}
          {partAsked && <Text style={text.muted}>{askedMessage(partAsked)}</Text>}
        </View>
        <View style={{ marginTop: 24 }}>
          <CastRail cast={data.cast} />
          <CollectionRail details={data} />
          <SimilarRail details={data} />
        </View>
      </ScrollView>
      {back}
    </View>
  );
}

const styles = StyleSheet.create({
  more: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  moreText: { color: colors.text2, fontWeight: '600', fontSize: 14 },
  info: { paddingHorizontal: gutter, gap: 12, marginTop: -60 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14 },
  poster: { width: 96, height: 144, borderRadius: radius.s },
  title: { color: colors.text, fontSize: 26, fontWeight: '900' },
  facts: { fontSize: 14, color: colors.text2, fontWeight: '600' },
  status: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.m,
    backgroundColor: colors.surface,
  },
  statusText: { fontWeight: '800', fontSize: 16 },
  error: { fontSize: 14, color: '#f08a7a' },
});

// The TV has its own screens, for the remote.
export default isTV ? TvDiscoverTitle : DiscoverTitleScreen;
