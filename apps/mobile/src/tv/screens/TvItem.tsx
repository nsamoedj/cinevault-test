// A film or series on the TV, as on Netflix: the backdrop over the whole
// screen with the logo, facts and description, "Afspelen" (which has the
// focus) and round buttons for the rest; below, the seasons and episodes,
// "Meer zoals dit" and the cast. The page scrolls to the part the focus goes
// to. The remote's back button goes back.

import {
  airDateLabel,
  type CastMemberDto,
  type EpisodeDto,
  isLatinScript,
  isResumable,
  type ItemDetails,
  showStart,
  trailerUrl,
  upcomingLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ageFact, DownloadLine } from '../../components/Download';
import { router, useLocalSearchParams } from 'expo-router';
import { type ComponentRef, useCallback, useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Icon } from '../../components/Icon';
import { qualityBadges } from '../../components/sizes';
import {
  ErrorView,
  Loading,
  ProgressBar,
  ServerImage,
  TitleLogo,
  WatchedBadge,
} from '../../components/ui';
import { channelsLabel, clockLabel, countLabel, runtimeLabel, seasonLabel } from '../../format';
import { keys } from '../../keys';
import { useMyListToggle } from '../../myList';
import { useThemeMusic } from '../../themeMusic';
import { useSession } from '../../session';
import { colors } from '../../theme';
import { FocusMemory, FocusScale, noFocusStyle, TvPressable } from '../focus';
import { TvSection, TvStack } from '../stack';
import { Badges, HeroBackdrop } from '../Hero';
import { createSpotStore } from '../spotlight';
import {
  CardFrame,
  TV_GUTTER,
  TvButton,
  TvChip,
  TvIconButton,
  TvMissingPartCard,
  TvPosterCard,
  TvRow,
  tvText,
  useTvSizes,
} from '../ui';

function useWatched(itemId: string) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { kind: 'items' | 'seasons' | 'episodes'; id: string; watched: boolean }) =>
      api.setWatched(args.kind, args.id, args.watched),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.item(itemId) });
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: keys.continue });
    },
  });
}

function badges(item: ItemDetails): string[] {
  const files =
    item.type === 'SHOW'
      ? item.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files))
      : item.files;
  const best = [...files].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (!best) return [];
  const list = qualityBadges(best.height, best.hdrFormat);
  const channels = Math.max(0, ...best.audioTracks.map((t) => t.channels ?? 0));
  if (channels >= 6) list.push(channelsLabel(channels));
  return list;
}

function EpisodeCard({
  episode,
  width,
  onFocus,
}: {
  episode: EpisodeDto;
  width: number;
  onFocus: () => void;
}) {
  const file = episode.files[0];
  const progress = episode.progress;
  const watched = progress?.watched ?? false;
  const share =
    progress && !watched && progress.durationMs ? progress.positionMs / progress.durationMs : 0;
  const title = episode.title ?? `Aflevering ${episode.episodeNumber}`;
  return (
    <TvPressable
      accessibilityRole="button"
      accessibilityLabel={`Aflevering ${episode.episodeNumber}: ${title}, afspelen`}
      disabled={!file}
      onPress={() => file && router.push(`/play/${file.id}`)}
      onFocus={onFocus}
      focusStyle={noFocusStyle}
      style={{ width }}
    >
      {({ focused }) => (
        <>
          <CardFrame focused={focused} width={width} ratio={9 / 16}>
            <ServerImage
              path={episode.stillUrl}
              style={StyleSheet.absoluteFill}
              fallback={String(episode.episodeNumber)}
            />
            <Text style={styles.episodeNumber}>{episode.episodeNumber}</Text>
            {focused && file && (
              <View style={styles.stillPlay}>
                <Icon name="play" size={18} color={colors.ink} />
              </View>
            )}
            {share > 0 && <ProgressBar share={share} style={styles.stillProgress} />}
            {watched && <WatchedBadge />}
          </CardFrame>
          <Text style={[styles.episodeTitle, focused && { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={tvText.small} numberOfLines={1}>
            {file ? runtimeLabel(episode.runtimeMinutes) : 'geen bestand'}
          </Text>
          {/* Always the same height, so the row doesn't jump as the focus moves. */}
          <Text style={styles.episodeOverview} numberOfLines={3}>
            {focused ? (episode.overview ?? '') : ''}
          </Text>
        </>
      )}
    </TvPressable>
  );
}

function Seasons({ item, onFocus }: { item: ItemDetails; onFocus: () => void }) {
  const watched = useWatched(item.id);
  const { landscape } = useTvSizes();
  const ordered = [...item.seasons].sort(
    (a, b) => (a.seasonNumber || 1000) - (b.seasonNumber || 1000),
  );
  const current = ordered.find((s) => s.episodes.some((e) => e.progress && !e.progress.watched));
  const [selected, setSelected] = useState(current?.id ?? ordered[0]?.id);
  const season = ordered.find((s) => s.id === selected) ?? ordered[0];
  if (!season) return null;
  const allWatched =
    season.episodes.length > 0 && season.episodes.every((e) => e.progress?.watched);

  return (
    <View style={{ gap: 4 }}>
      {/* The chips may wrap: up and down between their lines stay Android's. */}
      <TvSection order={1} wraps>
        <View style={styles.seasons}>
          {ordered.map((s) => (
            <TvChip
              key={s.id}
              label={seasonLabel(s.seasonNumber)}
              on={s.id === season.id}
              onPress={() => setSelected(s.id)}
              onFocus={onFocus}
            />
          ))}
          <TvChip
            label={allWatched ? 'Seizoen gezien ✓' : 'Seizoen als gezien'}
            on={allWatched}
            onPress={() => watched.mutate({ kind: 'seasons', id: season.id, watched: !allWatched })}
            onFocus={onFocus}
            lastInLine
          />
        </View>
      </TvSection>
      <TvSection order={2}>
        <TvRow
          key={season.id}
          title={`${seasonLabel(season.seasonNumber)} · ${countLabel(season.episodes.length, 'aflevering', 'afleveringen')}`}
          data={season.episodes}
          keyOf={(episode) => episode.id}
          itemWidth={landscape}
          onFocus={onFocus}
          render={(episode, _index, focus) => (
            <EpisodeCard episode={episode} width={landscape} onFocus={focus} />
          )}
        />
      </TvSection>
    </View>
  );
}

/** The film's collection: all its films in order, also the ones not here. */
function CollectionRow({
  collection,
  onFocus,
}: {
  collection: { id: number; name: string };
  onFocus: () => void;
}) {
  const { api, user } = useSession();
  const { poster } = useTvSizes();
  const details = useQuery({
    queryKey: keys.collection(collection.id),
    queryFn: () => api.collection(collection.id),
  });
  if (!details.data || details.data.parts.length < 2) return null;
  const canAsk = user?.maxAge === undefined;
  return (
    <TvRow
      title={details.data.name}
      data={details.data.parts}
      keyOf={(part) => String(part.tmdbId)}
      itemWidth={poster}
      onFocus={onFocus}
      render={(part, _index, focus) =>
        part.item ? (
          <TvPosterCard item={part.item} width={poster} titled onFocus={focus} />
        ) : (
          <TvMissingPartCard part={part} width={poster} canAsk={canAsk} titled onFocus={focus} />
        )
      }
    />
  );
}

/** "Meer zoals dit": TMDB's recommendations that are in the library, then the same genres. */
function SimilarRow({ itemId, onFocus }: { itemId: string; onFocus: () => void }) {
  const { api } = useSession();
  const { poster } = useTvSizes();
  const similar = useQuery({ queryKey: keys.similar(itemId), queryFn: () => api.similar(itemId) });
  if (!similar.data || similar.data.length === 0) return null;
  return (
    <TvRow
      title="Meer zoals dit"
      data={similar.data}
      keyOf={(item) => item.id}
      itemWidth={poster}
      onFocus={onFocus}
      render={(item, _index, focus) => (
        <TvPosterCard item={item} width={poster} titled onFocus={focus} />
      )}
    />
  );
}

export function CastRow({ cast, onFocus }: { cast: CastMemberDto[]; onFocus: () => void }) {
  return (
    <TvRow
      title="Cast"
      data={cast}
      keyOf={(person) => `${person.name}-${person.character ?? ''}`}
      itemWidth={112}
      onFocus={onFocus}
      render={(person, _index, focus) => (
        <TvPressable onFocus={focus} focusStyle={noFocusStyle} style={styles.person}>
          {({ focused }) => (
            <>
              <FocusScale
                focused={focused}
                style={[styles.personPhoto, focused && styles.personPhotoFocused]}
              >
                <ServerImage
                  path={person.profileUrl}
                  style={StyleSheet.absoluteFill}
                  fallback={person.name.charAt(0)}
                />
              </FocusScale>
              <Text style={styles.personName} numberOfLines={2}>
                {person.name}
              </Text>
              {person.character ? (
                <Text style={styles.personRole} numberOfLines={1}>
                  {person.character}
                </Text>
              ) : null}
            </>
          )}
        </TvPressable>
      )}
    />
  );
}

export function TvItem() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { height } = useWindowDimensions();
  const watched = useWatched(id);
  const [noTrailerApp, setNoTrailerApp] = useState(false);
  const item = useQuery({
    queryKey: keys.item(id),
    queryFn: () => api.item(id),
    refetchInterval: (query) => (query.state.data?.download ? 15_000 : false),
  });
  const list = useMyListToggle(id, item.data?.inMyList ?? false);
  const music = useThemeMusic(id, Boolean(item.data));
  const [store] = useState(() => createSpotStore());
  const page = useRef<ComponentRef<typeof ScrollView>>(null);
  const sections = useRef<Record<string, number>>({});
  const file = item.data
    ? item.data.type === 'SHOW'
      ? showStart(item.data)?.episode.files[0]
      : item.data.files[0]
    : undefined;
  // The black-bar check of what "Afspelen" plays, so the player knows the fit at once.
  useQuery({
    queryKey: keys.picture(file?.id ?? ''),
    queryFn: () => api.picture(file?.id ?? ''),
    enabled: Boolean(file),
    staleTime: Infinity,
    retry: false,
  });
  // The page scrolls to where the focus goes: a section's top, or the start.
  const scrollTo = useCallback((section?: string) => {
    const y = section ? Math.max(0, (sections.current[section] ?? 0) - 16) : 0;
    page.current?.scrollTo({ y });
  }, []);
  const measured = useCallback((section: string, y: number) => {
    sections.current[section] = y;
  }, []);
  useEffect(() => {
    if (item.data)
      store.set({
        key: item.data.id,
        title: item.data.title,
        facts: [],
        ...(item.data.backdropUrl && { backdropUrl: item.data.backdropUrl }),
      });
  }, [item.data, store]);

  if (item.isPending) return <Loading />;
  if (item.isError) return <ErrorView error={item.error} onRetry={() => void item.refetch()} />;
  const data = item.data;
  const isShow = data.type === 'SHOW';
  const start = isShow ? showStart(data) : undefined;
  const progress = isShow ? start?.episode.progress : data.resume;
  const resume = isResumable(progress) && progress.fileId === file?.id ? progress : undefined;
  const seasonCount = data.seasons.filter((s) => s.seasonNumber > 0).length;
  const facts = [
    data.year ? String(data.year) : '',
    data.rating ? `★ ${data.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}` : '',
    ageFact(data.ageRating),
    isShow
      ? seasonCount > 0
        ? `${seasonCount} ${seasonCount === 1 ? 'seizoen' : 'seizoenen'}`
        : ''
      : runtimeLabel(data.runtimeMinutes),
  ].filter(Boolean);
  let playLabel = 'Afspelen';
  if (resume) playLabel = `Verder kijken (${clockLabel(resume.positionMs / 1000)})`;
  else if (start && !(start.season.seasonNumber === 1 && start.episode.episodeNumber === 1)) {
    playLabel = `Afspelen S${start.season.seasonNumber}:A${start.episode.episodeNumber}`;
  }
  const castLine = data.cast
    .slice(0, 4)
    .map((person) => person.name)
    .join(', ');

  const atTop = () => scrollTo();

  return (
    <FocusMemory>
      <TvStack>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <HeroBackdrop store={store} />
          {/* The sections are direct children, so their onLayout y is their place on the page. */}
          <ScrollView
            ref={page}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 48, gap: 18 }}
          >
            <View style={[styles.info, { minHeight: Math.round(height * 0.86) }]}>
              <Text style={tvText.eyebrow}>
                {[isShow ? 'Serie' : 'Film', ...data.genres.slice(0, 3)].join('  ·  ')}
              </Text>
              <TitleLogo
                key={data.logoUrl}
                path={data.logoUrl}
                title={data.title}
                width={Math.round(height * 0.62)}
                height={Math.round(height * 0.17)}
                align="left"
                textStyle={styles.title}
              />
              {data.originalTitle && isLatinScript(data.originalTitle) ? (
                <Text style={[tvText.muted, { fontStyle: 'italic' }]}>{data.originalTitle}</Text>
              ) : null}
              <View style={styles.factRow}>
                <Text style={styles.facts}>{facts.join('   ·   ')}</Text>
                <Badges list={badges(data)} />
              </View>
              {data.download && (
                <View style={{ maxWidth: 560 }}>
                  <DownloadLine download={data.download} large />
                </View>
              )}
              {data.nextEpisode && (
                <View style={styles.nextAir}>
                  <Icon name="calendar" size={20} color={colors.brass} />
                  <Text style={tvText.muted}>
                    Nieuwe aflevering{' '}
                    <Text style={{ color: colors.text, fontWeight: '700' }}>
                      {airDateLabel(data.nextEpisode.airDate)}
                    </Text>
                    : {upcomingLabel(data.nextEpisode)}
                  </Text>
                </View>
              )}
              {data.overview ? (
                <Text style={styles.overview} numberOfLines={4}>
                  {data.overview}
                </Text>
              ) : null}
              {castLine ? (
                <Text style={tvText.small} numberOfLines={1}>
                  Met {castLine}
                </Text>
              ) : null}
              {resume && resume.durationMs && (
                <View style={styles.resume}>
                  <ProgressBar
                    share={resume.positionMs / resume.durationMs}
                    style={{ flex: 1, borderRadius: 2 }}
                  />
                  <Text style={tvText.small}>
                    nog {clockLabel((resume.durationMs - resume.positionMs) / 1000)}
                  </Text>
                </View>
              )}
              <TvSection order={0}>
                <View style={styles.buttons}>
                  {file && (
                    <TvButton
                      label={playLabel}
                      icon="play"
                      primary
                      autoFocus
                      onFocus={atTop}
                      onPress={() => router.push(`/play/${file.id}`)}
                    />
                  )}
                  {resume && file && (
                    <TvIconButton
                      label="Vanaf het begin"
                      icon="replay10"
                      onFocus={atTop}
                      onPress={() =>
                        router.push({
                          pathname: '/play/[fileId]',
                          params: { fileId: file.id, start: '0' },
                        })
                      }
                    />
                  )}
                  {data.trailerKey && (
                    <TvIconButton
                      label="Trailer"
                      icon="film"
                      onFocus={atTop}
                      // The YouTube app for TVs; without it there is nothing to open the link.
                      onPress={() =>
                        Linking.openURL(trailerUrl(data.trailerKey ?? '')).catch(() =>
                          setNoTrailerApp(true),
                        )
                      }
                    />
                  )}
                  {music.playing && (
                    <TvIconButton
                      label="Muziek stoppen"
                      icon="volume"
                      onFocus={atTop}
                      onPress={music.stop}
                    />
                  )}
                  <TvIconButton
                    label={list.label}
                    icon={list.on ? 'check' : 'plus'}
                    on={list.on}
                    onFocus={atTop}
                    onPress={list.toggle}
                  />
                  <TvIconButton
                    label={
                      data.progress?.watched ? 'Gezien' : isShow ? 'Alles als gezien' : 'Als gezien'
                    }
                    icon="check"
                    on={data.progress?.watched}
                    autoFocus={!file}
                    lastInLine
                    onFocus={atTop}
                    onPress={() =>
                      watched.mutate({
                        kind: 'items',
                        id: data.id,
                        watched: !data.progress?.watched,
                      })
                    }
                  />
                </View>
              </TvSection>
              {noTrailerApp && (
                <Text style={tvText.small}>
                  Geen app gevonden voor de trailer. Installeer YouTube op deze tv.
                </Text>
              )}
            </View>

            {isShow && (
              <View onLayout={(event) => measured('seasons', event.nativeEvent.layout.y)}>
                <Seasons item={data} onFocus={() => scrollTo('seasons')} />
              </View>
            )}
            {data.collection && (
              <View onLayout={(event) => measured('collection', event.nativeEvent.layout.y)}>
                <TvSection order={3}>
                  <CollectionRow
                    collection={data.collection}
                    onFocus={() => scrollTo('collection')}
                  />
                </TvSection>
              </View>
            )}
            <View onLayout={(event) => measured('similar', event.nativeEvent.layout.y)}>
              <TvSection order={4}>
                <SimilarRow itemId={data.id} onFocus={() => scrollTo('similar')} />
              </TvSection>
            </View>
            {data.cast.length > 0 && (
              <View onLayout={(event) => measured('cast', event.nativeEvent.layout.y)}>
                <TvSection order={5}>
                  <CastRow cast={data.cast} onFocus={() => scrollTo('cast')} />
                </TvSection>
              </View>
            )}
            {data.metadataProvider ? (
              <Text style={[tvText.small, { paddingHorizontal: TV_GUTTER }]}>
                Gegevens: {data.metadataProvider.includes('tmdb') ? 'TMDB' : ''}
                {data.metadataProvider.includes('tmdb') && data.metadataProvider.includes('tvmaze')
                  ? ' en '
                  : ''}
                {data.metadataProvider.includes('tvmaze') ? 'TVmaze (CC BY-SA 4.0)' : ''}
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </TvStack>
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  info: {
    paddingHorizontal: TV_GUTTER,
    paddingTop: 40,
    paddingBottom: 36,
    width: '60%',
    gap: 10,
    justifyContent: 'flex-end',
  },
  title: { color: colors.text, fontSize: 44, fontWeight: '900', letterSpacing: -0.6 },
  factRow: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  facts: { color: colors.text2, fontWeight: '700', fontSize: 16 },
  overview: { color: colors.text, fontSize: 17, lineHeight: 25 },
  buttons: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 10, height: 76 },
  resume: { flexDirection: 'row', alignItems: 'center', gap: 12, maxWidth: 420 },
  nextAir: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  seasons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: TV_GUTTER,
    paddingVertical: 6,
  },
  episodeNumber: {
    position: 'absolute',
    left: 10,
    bottom: 6,
    color: colors.text,
    fontSize: 26,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 6,
  },
  stillPlay: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  stillProgress: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  episodeTitle: {
    color: colors.text2,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 10,
    paddingHorizontal: 2,
  },
  episodeOverview: {
    color: colors.text2,
    fontSize: 13,
    lineHeight: 18,
    height: 54,
    paddingHorizontal: 2,
  },
  person: { width: 112, alignItems: 'center', gap: 6 },
  personPhoto: {
    width: 96,
    height: 96,
    borderRadius: 48,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  personPhotoFocused: { borderColor: colors.brass },
  personName: { color: colors.text, fontWeight: '700', fontSize: 14, textAlign: 'center' },
  personRole: { color: colors.text3, fontSize: 12, textAlign: 'center' },
});
