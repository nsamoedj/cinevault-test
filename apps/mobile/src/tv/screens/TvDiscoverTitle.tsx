// A title from "Ontdekken" on the TV: the backdrop, what it is, and
// "Aanvragen" (with the focus); for a show also some seasons, and the cast.
// Back goes back.

import type { DiscoverDetails, MediaRequestDto, RequestKind } from '@cinevault/shared';
import { discoverPartLabel, requestPartsLabel, trailerUrl } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadLine } from '../../components/Download';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { type ComponentRef, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { ErrorView, Loading, ServerImage, errorText } from '../../components/ui';
import { kindLabel, releaseLine, STATUS_LABEL, useAskFor } from '../../discover';
import { runtimeLabel } from '../../format';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors } from '../../theme';
import { FocusMemory } from '../focus';
import { TvDiscoverCard } from '../discover';
import { TV_GUTTER, TvButton, TvChip, TvRow, tvText, useTvSizes } from '../ui';
import { TvSection, TvStack } from '../stack';
import { CastRow } from './TvItem';

/** What happens now with a request just made. */
function askedMessage(request: MediaRequestDto): string {
  if (request.status === 'PENDING') {
    return 'Aangevraagd. Je krijgt een melding als een beheerder het goedkeurt.';
  }
  if (request.status === 'APPROVED') return 'Aangevraagd. Het wordt nu gezocht.';
  return request.reason ?? '';
}

/** The film's collection, in order; this one marked. */
function CollectionRow({ data, onFocus }: { data: DiscoverDetails; onFocus: () => void }) {
  const { poster } = useTvSizes();
  const collection = data.collection;
  if (!collection) return null;
  return (
    <TvRow
      title={collection.name}
      data={collection.parts}
      keyOf={(part) => String(part.tmdbId)}
      itemWidth={poster}
      onFocus={onFocus}
      render={(part, _index, focus) => {
        const current = part.tmdbId === data.tmdbId;
        return (
          <TvDiscoverCard
            item={part}
            width={poster}
            titled
            sub={discoverPartLabel(part, current)}
            current={current}
            onFocus={focus}
          />
        );
      }}
    />
  );
}

/** "Meer zoals dit": TMDB's recommendations; OK opens one. */
function SimilarRow({ data, onFocus }: { data: DiscoverDetails; onFocus: () => void }) {
  const { poster } = useTvSizes();
  if (!data.similar || data.similar.length === 0) return null;
  return (
    <TvRow
      title="Meer zoals dit"
      data={data.similar}
      keyOf={(item) => `${item.kind}-${item.tmdbId}`}
      itemWidth={poster}
      onFocus={onFocus}
      render={(item, _index, focus) => (
        <TvDiscoverCard item={item} width={poster} titled onFocus={focus} />
      )}
    />
  );
}

/** A show's seasons as chips: pick some, and ask for those (single episodes on a phone). */
function TvSeasons({ data, onFocus }: { data: DiscoverDetails; onFocus: () => void }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<number[]>([]);
  const ask = useMutation({
    mutationFn: () =>
      api.createRequest({ kind: 'show', tmdbId: data.tmdbId, anime: data.anime, seasons: picked }),
    onSuccess: () => setPicked([]),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['discover'] }),
        queryClient.invalidateQueries({ queryKey: keys.requests }),
      ]),
  });
  const label = requestPartsLabel({ seasons: picked });
  const seasons = data.seasonList ?? [];
  return (
    <View style={styles.seasons}>
      <Text style={tvText.h2}>Seizoenen aanvragen</Text>
      {/* The chips may wrap: up and down between their lines stay Android's. */}
      <TvSection order={1} wraps>
        <View style={styles.chips}>
          {seasons.map((season, index) => {
            const here = season.episodeCount > 0 && season.inLibrary >= season.episodeCount;
            const done = here || season.requested;
            const state = here
              ? ' · staat er al'
              : season.requested
                ? ' · aangevraagd'
                : season.inLibrary > 0
                  ? ` · ${season.inLibrary}/${season.episodeCount}`
                  : '';
            return (
              <TvChip
                key={season.seasonNumber}
                label={`Seizoen ${season.seasonNumber}${state}`}
                on={done || picked.includes(season.seasonNumber)}
                onFocus={onFocus}
                lastInLine={index === seasons.length - 1}
                onPress={() => {
                  if (done) return;
                  setPicked((current) =>
                    current.includes(season.seasonNumber)
                      ? current.filter((n) => n !== season.seasonNumber)
                      : [...current, season.seasonNumber],
                  );
                }}
              />
            );
          })}
        </View>
      </TvSection>
      {label && (
        <TvSection order={2}>
          <View style={styles.buttons}>
            <TvButton
              label={`${label} aanvragen`}
              icon="plus"
              primary
              lastInLine
              disabled={ask.isPending}
              onPress={() => ask.mutate()}
            />
          </View>
        </TvSection>
      )}
      {ask.isSuccess && <Text style={tvText.muted}>{askedMessage(ask.data)}</Text>}
      {ask.isError && <Text style={styles.error}>{errorText(ask.error)}</Text>}
    </View>
  );
}

export function TvDiscoverTitle() {
  const params = useLocalSearchParams<{ kind: RequestKind; id: string }>();
  const kind: RequestKind = params.kind === 'show' ? 'show' : 'movie';
  const tmdbId = Number(params.id);
  const { api } = useSession();
  const { height } = useWindowDimensions();
  const [noTrailerApp, setNoTrailerApp] = useState(false);
  const details = useQuery({
    queryKey: ['discover', 'details', kind, tmdbId],
    queryFn: () => api.discoverDetails(kind, tmdbId),
    refetchInterval: (query) => (query.state.data?.download ? 15_000 : false),
  });
  const ask = useAskFor({ kind, tmdbId, title: '', anime: details.data?.anime ?? false });
  const page = useRef<ComponentRef<typeof ScrollView>>(null);
  const sections = useRef<Record<string, number>>({});
  // The page scrolls to where the focus goes: a section's top, or the start.
  const scrollTo = (section?: string) =>
    page.current?.scrollTo({
      y: section ? Math.max(0, (sections.current[section] ?? 0) - 16) : 0,
    });
  if (details.isPending) return <Loading />;
  if (details.isError) {
    return <ErrorView error={details.error} onRetry={() => void details.refetch()} />;
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
    <FocusMemory>
      <TvStack>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <ServerImage path={data.backdropUrl ?? data.posterUrl} style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={[colors.bg, 'rgba(10,18,48,0.9)', 'rgba(10,18,48,0.15)']}
            locations={[0, 0.45, 0.85]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
          <ScrollView ref={page} contentContainerStyle={{ paddingBottom: 48 }}>
            <View style={[styles.info, { minHeight: height * 0.8 }]}>
              <Text style={tvText.eyebrow}>{kindLabel(data)}</Text>
              <Text style={styles.title} numberOfLines={2}>
                {data.title}
              </Text>
              <Text style={styles.facts}>{facts.join('  ·  ')}</Text>
              {data.genres.length > 0 && (
                <Text style={tvText.small}>{data.genres.join(' · ')}</Text>
              )}
              {releaseLine(data) && <Text style={tvText.muted}>{releaseLine(data)}</Text>}
              {data.download && <DownloadLine download={data.download} large />}
              {data.overview ? (
                <Text style={tvText.body} numberOfLines={5}>
                  {data.overview}
                </Text>
              ) : null}
              <TvSection order={0}>
                <View style={styles.buttons}>
                  {data.itemId ? (
                    <TvButton
                      label="In de bibliotheek"
                      icon="play"
                      primary
                      autoFocus
                      onPress={() => router.push(`/item/${data.itemId}`)}
                    />
                  ) : status && status !== 'DECLINED' ? (
                    // A button, as "Aanvragen" was: the same view, so the focus
                    // stays on it. A text in its place took the focus away (to
                    // the menu) right after asking.
                    <TvButton
                      label={STATUS_LABEL[status]}
                      icon="check"
                      autoFocus
                      lastInLine={!data.trailerKey}
                      onFocus={() => scrollTo()}
                    />
                  ) : (
                    <TvButton
                      label={
                        status === 'DECLINED'
                          ? 'Opnieuw aanvragen'
                          : data.kind === 'show'
                            ? 'Hele serie aanvragen'
                            : 'Aanvragen'
                      }
                      icon="plus"
                      primary
                      autoFocus
                      lastInLine={!data.trailerKey}
                      disabled={ask.isPending}
                      onFocus={() => scrollTo()}
                      onPress={() => ask.mutate()}
                    />
                  )}
                  {data.trailerKey && (
                    <TvButton
                      label="Trailer"
                      icon="film"
                      lastInLine
                      onPress={() =>
                        Linking.openURL(trailerUrl(data.trailerKey ?? '')).catch(() =>
                          setNoTrailerApp(true),
                        )
                      }
                    />
                  )}
                </View>
              </TvSection>
              {ask.isSuccess && <Text style={tvText.muted}>{askedMessage(ask.data)}</Text>}
              {ask.isError && <Text style={styles.error}>{errorText(ask.error)}</Text>}
              {noTrailerApp && (
                <Text style={tvText.small}>
                  Geen app gevonden voor de trailer. Installeer YouTube op deze tv.
                </Text>
              )}
            </View>
            {data.kind === 'show' &&
              status !== 'PENDING' &&
              status !== 'APPROVED' &&
              data.seasonList &&
              data.seasonList.length > 0 && (
                <View onLayout={(event) => (sections.current.seasons = event.nativeEvent.layout.y)}>
                  <TvSeasons data={data} onFocus={() => scrollTo('seasons')} />
                </View>
              )}
            {data.cast.length > 0 && (
              <View onLayout={(event) => (sections.current.cast = event.nativeEvent.layout.y)}>
                <TvSection order={3}>
                  <CastRow cast={data.cast} onFocus={() => scrollTo('cast')} />
                </TvSection>
              </View>
            )}
            {data.collection && (
              <View
                onLayout={(event) => (sections.current.collection = event.nativeEvent.layout.y)}
              >
                <TvSection order={4}>
                  <CollectionRow data={data} onFocus={() => scrollTo('collection')} />
                </TvSection>
              </View>
            )}
            {data.similar && data.similar.length > 0 && (
              <View onLayout={(event) => (sections.current.similar = event.nativeEvent.layout.y)}>
                <TvSection order={5}>
                  <SimilarRow data={data} onFocus={() => scrollTo('similar')} />
                </TvSection>
              </View>
            )}
          </ScrollView>
        </View>
      </TvStack>
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  info: {
    flex: 1,
    width: '60%',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: TV_GUTTER,
    paddingVertical: 40,
  },
  title: { color: colors.text, fontSize: 40, fontWeight: '900', letterSpacing: -0.5 },
  facts: { color: colors.text2, fontWeight: '700', fontSize: 16 },
  buttons: { flexDirection: 'row', gap: 14, marginTop: 10 },
  error: { color: '#f08a7a', fontSize: 16 },
  seasons: { paddingHorizontal: TV_GUTTER, gap: 12, marginBottom: 24 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
