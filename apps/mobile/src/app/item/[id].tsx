import {
  airDateLabel,
  type EpisodeDto,
  isLatinScript,
  isResumable,
  type ItemDetails,
  type RemoveTarget,
  type SeasonDto,
  showStart,
  trailerUrl,
  upcomingLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { carLayout, isCar, px } from '../../car';
import { Icon } from '../../components/Icon';
import { CastRail } from '../../components/CastRail';
import { ageFact, DownloadLine } from '../../components/Download';
import { RemoveSheet } from '../../components/RemoveSheet';
import { ItemAdmin } from '../../admin/ItemAdmin';
import { qualityBadges, useCardWidths } from '../../components/sizes';
import {
  Button,
  ErrorView,
  IconButton,
  Loading,
  MissingPartCard,
  PosterCard,
  ProgressBar,
  Rail,
  ServerImage,
  text,
  TitleLogo,
  WatchedBadge,
} from '../../components/ui';
import { channelsLabel, clockLabel, runtimeLabel, seasonLabel } from '../../format';
import { keys } from '../../keys';
import { useSession } from '../../session';
import { colors, gutter, radius } from '../../theme';
import { isTV } from '../../tv/focus';
import { TvItem } from '../../tv/screens/TvItem';
import { useMyListToggle } from '../../myList';
import { useThemeMusic } from '../../themeMusic';

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

function EpisodeRow({
  episode,
  onWatched,
  onRemove,
}: {
  episode: EpisodeDto;
  onWatched: (watched: boolean) => void;
  /** Admins: hold the episode to remove it. */
  onRemove?: () => void;
}) {
  const file = episode.files[0];
  const progress = episode.progress;
  const watched = progress?.watched ?? false;
  const share =
    progress && !watched && progress.durationMs ? progress.positionMs / progress.durationMs : 0;
  const title = episode.title ?? `Aflevering ${episode.episodeNumber}`;
  return (
    <View style={styles.episode}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Aflevering ${episode.episodeNumber}: ${title}, afspelen`}
        disabled={!file}
        onPress={() => file && router.push(`/play/${file.id}`)}
        {...(onRemove && { onLongPress: onRemove, delayLongPress: 450 })}
        style={({ pressed }) => [styles.episodeMain, pressed && { opacity: 0.8 }]}
      >
        <View style={[styles.still, isCar && styles.carStill]}>
          <ServerImage
            path={episode.stillUrl}
            style={StyleSheet.absoluteFill}
            fallback={String(episode.episodeNumber)}
          />
          {file && (
            <View style={styles.stillPlay}>
              <Icon name="play" size={16} />
            </View>
          )}
          {share > 0 && <ProgressBar share={share} style={styles.stillProgress} />}
          {watched && <WatchedBadge />}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.episodeTitle} numberOfLines={2}>
            <Text style={{ color: colors.text3 }}>{episode.episodeNumber} </Text>
            {title}
          </Text>
          <Text style={text.small}>
            {[runtimeLabel(episode.runtimeMinutes), file ? '' : 'geen bestand']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      </Pressable>
      {episode.overview ? (
        <Text style={styles.episodeOverview} numberOfLines={3}>
          {episode.overview}
        </Text>
      ) : null}
      <IconButton
        icon={watched ? 'check' : 'plus'}
        label={watched ? 'Gezien' : 'Markeer als gezien'}
        size={38}
        color={watched ? colors.brass : colors.text2}
        onPress={() => onWatched(!watched)}
        style={styles.episodeWatched}
      />
    </View>
  );
}

function Seasons({
  item,
  onRemove,
}: {
  item: ItemDetails;
  /** Admins: remove a season or an episode. */
  onRemove?: (target: RemoveTarget) => void;
}) {
  const watched = useWatched(item.id);
  const ordered = [...item.seasons].sort(
    (a, b) => (a.seasonNumber || 1000) - (b.seasonNumber || 1000),
  );
  const current = ordered.find((s) => s.episodes.some((e) => e.progress && !e.progress.watched));
  const [selected, setSelected] = useState(current?.id ?? ordered[0]?.id);
  const [picking, setPicking] = useState(false);
  const season: SeasonDto | undefined = ordered.find((s) => s.id === selected) ?? ordered[0];
  if (!season) return null;
  const allWatched =
    season.episodes.length > 0 && season.episodes.every((e) => e.progress?.watched);

  return (
    <View style={[{ gap: 12, paddingHorizontal: gutter }, isCar && styles.carSeasons]}>
      <View style={styles.seasonHead}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Seizoen kiezen, nu ${seasonLabel(season.seasonNumber)}`}
          disabled={ordered.length < 2}
          onPress={() => setPicking(true)}
          style={styles.seasonPick}
        >
          <Text style={text.h2}>{seasonLabel(season.seasonNumber)}</Text>
          {ordered.length > 1 && <Icon name="chevronDown" size={20} color={colors.text2} />}
        </Pressable>
        <View style={{ flexDirection: 'row' }}>
          {onRemove && (
            <IconButton
              icon="trash"
              label={`${seasonLabel(season.seasonNumber)} verwijderen`}
              color={colors.text2}
              onPress={() => onRemove({ scope: 'season', seasonId: season.id })}
            />
          )}
          <IconButton
            icon={allWatched ? 'check' : 'plus'}
            label={allWatched ? 'Seizoen gezien' : 'Seizoen als gezien markeren'}
            color={allWatched ? colors.brass : colors.text2}
            onPress={() => watched.mutate({ kind: 'seasons', id: season.id, watched: !allWatched })}
          />
        </View>
      </View>
      {season.episodes.map((episode) => (
        <EpisodeRow
          key={episode.id}
          episode={episode}
          onWatched={(value) =>
            watched.mutate({ kind: 'episodes', id: episode.id, watched: value })
          }
          {...(onRemove &&
            episode.files.length > 0 && {
              onRemove: () => onRemove({ scope: 'episode', episodeId: episode.id }),
            })}
        />
      ))}
      {picking && (
        <Modal transparent animationType="fade" onRequestClose={() => setPicking(false)}>
          <Pressable style={styles.scrim} onPress={() => setPicking(false)}>
            <View style={styles.seasonList}>
              <ScrollView>
                {ordered.map((s) => (
                  <Pressable
                    key={s.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: s.id === season.id }}
                    onPress={() => {
                      setSelected(s.id);
                      setPicking(false);
                    }}
                    style={styles.seasonOption}
                  >
                    <Text
                      style={[
                        text.h2,
                        s.id === season.id ? { color: colors.text } : { color: colors.text2 },
                      ]}
                    >
                      {seasonLabel(s.seasonNumber)}
                    </Text>
                    <Text style={text.small}>{s.episodes.length} afleveringen</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

/** "Meer zoals dit": TMDB's recommendations that are in the library, then the same genres. */
/** The film's collection: all its films in order, also the ones not here. */
function CollectionRail({ collection }: { collection: { id: number; name: string } }) {
  const { api, user } = useSession();
  const { poster } = useCardWidths();
  const details = useQuery({
    queryKey: keys.collection(collection.id),
    queryFn: () => api.collection(collection.id),
  });
  if (!details.data || details.data.parts.length < 2) return null;
  const canAsk = user?.maxAge === undefined;
  return (
    <Rail
      title={details.data.name}
      data={details.data.parts}
      keyOf={(part) => String(part.tmdbId)}
      render={(part) =>
        part.item ? (
          <PosterCard item={part.item} width={poster} />
        ) : (
          <MissingPartCard part={part} width={poster} canAsk={canAsk} />
        )
      }
      action={
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${details.data.name} openen`}
          hitSlop={8}
          onPress={() => router.push(`/collection/${collection.id}`)}
          style={styles.more}
        >
          <Text style={styles.moreText}>Alles</Text>
          <Icon name="chevronRight" size={16} color={colors.text2} />
        </Pressable>
      }
    />
  );
}

function SimilarRail({ itemId }: { itemId: string }) {
  const { api } = useSession();
  const { poster } = useCardWidths();
  const similar = useQuery({ queryKey: keys.similar(itemId), queryFn: () => api.similar(itemId) });
  if (!similar.data || similar.data.length === 0) return null;
  return (
    <Rail
      title="Meer zoals dit"
      data={similar.data}
      keyOf={(item) => item.id}
      render={(item) => <PosterCard item={item} width={poster} />}
    />
  );
}

/** Starts the black-bar check of what "Afspelen" plays, so the player knows the fit at once. */
function PicturePrefetch({ fileId }: { fileId: string }) {
  const { api } = useSession();
  useQuery({
    queryKey: keys.picture(fileId),
    queryFn: () => api.picture(fileId),
    staleTime: Infinity,
    retry: false,
  });
  return null;
}

function ItemScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { api, user } = useSession();
  // Beheer (matching, theme music, removing through Radarr or Sonarr): admins only;
  // members see nothing of it.
  const admin = user?.role === 'ADMIN';
  const [removing, setRemoving] = useState<RemoveTarget>();
  const insets = useSafeAreaInsets();
  const { width, height: screenHeight } = useWindowDimensions();
  const watched = useWatched(id);
  const item = useQuery({
    queryKey: keys.item(id),
    queryFn: () => api.item(id),
    // While Radarr or Sonarr downloads it, the bar moves.
    refetchInterval: (query) => (query.state.data?.download ? 15_000 : false),
  });
  const list = useMyListToggle(id, item.data?.inMyList ?? false);
  const music = useThemeMusic(id, Boolean(item.data));

  if (item.isPending) return <Loading />;
  if (item.isError) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorView error={item.error} onRetry={() => void item.refetch()} />
      </SafeAreaView>
    );
  }
  const data = item.data;
  const isShow = data.type === 'SHOW';
  const start = isShow ? showStart(data) : undefined;
  const file = isShow ? start?.episode.files[0] : data.files[0];
  const progress = isShow ? start?.episode.progress : data.resume;
  const resume = isResumable(progress) && progress.fileId === file?.id ? progress : undefined;
  const seasonCount = data.seasons.filter((s) => s.seasonNumber > 0).length;
  const facts = [
    data.rating ? `★ ${data.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}` : '',
    data.year ? String(data.year) : '',
    ageFact(data.ageRating),
    isShow
      ? seasonCount > 0
        ? `${seasonCount} ${seasonCount === 1 ? 'seizoen' : 'seizoenen'}`
        : ''
      : runtimeLabel(data.runtimeMinutes),
    ...badges(data),
  ].filter(Boolean);
  let playLabel = 'Afspelen';
  if (resume) playLabel = `Verder kijken (${clockLabel(resume.positionMs / 1000)})`;
  else if (start && !(start.season.seasonNumber === 1 && start.episode.episodeNumber === 1)) {
    playLabel = `Afspelen S${start.season.seasonNumber}:A${start.episode.episodeNumber}`;
  }
  // In a car (wide and low) the backdrop is lower, so the title and Afspelen show at once.
  const heroHeight = isCar
    ? // Whole pixels at the car's density, so no seam shows under the backdrop.
      4 * Math.round(Math.max(300, screenHeight * carLayout.hero * 0.85) / 4)
    : Math.min(460, (width * 10) / 16 + 40);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <View style={{ height: heroHeight }}>
          <ServerImage path={data.backdropUrl ?? data.posterUrl} style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={['rgba(10,18,48,0.6)', 'rgba(10,18,48,0)', colors.bg]}
            locations={[0, 0.35, isCar ? 0.94 : 1]}
            style={StyleSheet.absoluteFill}
          />
          {isCar && (
            <LinearGradient
              colors={['rgba(10,18,48,0.8)', 'rgba(10,18,48,0)']}
              locations={[0, 0.6]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          )}
        </View>
        <View style={[styles.info, isCar && styles.carInfo]}>
          <TitleLogo
            key={data.logoUrl}
            path={data.logoUrl}
            title={data.title}
            width={Math.min(width - 2 * px(gutter), px(300))}
            height={px(84)}
            align="left"
            textStyle={styles.title}
            numberOfLines={3}
          />
          {data.originalTitle && isLatinScript(data.originalTitle) ? (
            <Text style={[text.muted, { fontStyle: 'italic' }]}>{data.originalTitle}</Text>
          ) : null}
          <Text style={styles.facts}>{facts.join('  ·  ')}</Text>
          {data.genres.length > 0 && <Text style={text.muted}>{data.genres.join(' · ')}</Text>}
          {data.download && <DownloadLine download={data.download} large />}
          {data.nextEpisode && (
            <View style={styles.nextAir}>
              <Icon name="calendar" size={18} color={colors.brass} />
              <Text style={[text.muted, { flex: 1 }]}>
                Nieuwe aflevering{' '}
                <Text style={{ color: colors.text, fontWeight: '700' }}>
                  {airDateLabel(data.nextEpisode.airDate)}
                </Text>
                : {upcomingLabel(data.nextEpisode)}
              </Text>
            </View>
          )}
          {file && (
            <>
              <Button
                label={playLabel}
                icon="play"
                {...(isCar && { style: styles.carPlay })}
                onPress={() => router.push(`/play/${file.id}`)}
              />
              <PicturePrefetch fileId={file.id} />
            </>
          )}
          {resume && file && resume.durationMs && (
            <View style={[styles.resume, isCar && styles.carPlay]}>
              <ProgressBar
                share={resume.positionMs / resume.durationMs}
                style={{ flex: 1, borderRadius: 2 }}
              />
              <Text style={text.small}>
                nog {clockLabel((resume.durationMs - resume.positionMs) / 1000)}
              </Text>
            </View>
          )}
          <View style={[styles.actions, isCar && styles.carActions]}>
            {resume && file && !isShow && (
              <Button
                label="Vanaf het begin"
                icon="replay10"
                kind="glass"
                style={isCar ? styles.carAction : styles.action}
                onPress={() =>
                  router.push({
                    pathname: '/play/[fileId]',
                    params: { fileId: file.id, start: '0' },
                  })
                }
              />
            )}
            <Button
              label={
                data.progress?.watched ? 'Gezien' : isShow ? 'Alles gezien' : 'Markeer als gezien'
              }
              icon={data.progress?.watched ? 'check' : 'plus'}
              kind="glass"
              style={isCar ? styles.carAction : styles.action}
              onPress={() =>
                watched.mutate({ kind: 'items', id: data.id, watched: !data.progress?.watched })
              }
            />
            <Button
              label={list.label}
              icon={list.on ? 'check' : 'plus'}
              kind="glass"
              style={isCar ? styles.carAction : styles.action}
              onPress={list.toggle}
            />
            {music.playing && (
              <Button
                label="Muziek stoppen"
                icon="volume"
                kind="glass"
                style={isCar ? styles.carAction : styles.action}
                onPress={music.stop}
              />
            )}
            {data.trailerKey && (
              <Button
                label="Trailer"
                icon="film"
                kind="glass"
                style={isCar ? styles.carAction : styles.action}
                // The YouTube app, or the browser.
                onPress={() =>
                  void Linking.openURL(trailerUrl(data.trailerKey ?? '')).catch(() => {})
                }
              />
            )}
          </View>
          {data.tagline ? (
            <Text style={[text.muted, { fontStyle: 'italic' }]}>{data.tagline}</Text>
          ) : null}
          {data.overview ? <Text style={text.body}>{data.overview}</Text> : null}
        </View>

        <View style={{ gap: px(28), marginTop: px(24) }}>
          {isShow && <Seasons item={data} {...(admin && { onRemove: setRemoving })} />}
          <CastRail cast={data.cast} />
          {data.collection && <CollectionRail collection={data.collection} />}
          <SimilarRail itemId={data.id} />
          {admin && (
            <View style={styles.manage}>
              <Text style={text.h2}>Beheer</Text>
              <ItemAdmin item={data} />
              <Pressable
                accessibilityRole="button"
                onPress={() => setRemoving({ scope: 'title' })}
                style={({ pressed }) => [styles.removeButton, pressed && { opacity: 0.8 }]}
              >
                <Icon name="trash" size={20} color={colors.danger} />
                <Text style={styles.removeText}>
                  {isShow ? 'Serie verwijderen' : 'Film verwijderen'}
                </Text>
              </Pressable>
              <Text style={text.small}>
                {isShow
                  ? 'Via Sonarr, met alle bestanden. Een seizoen verwijder je met het prullenbakje bij het seizoen, een aflevering door hem lang ingedrukt te houden.'
                  : 'Via Radarr, met de map en de bestanden.'}
              </Text>
            </View>
          )}
          {data.metadataProvider ? (
            <Text style={[text.small, { paddingHorizontal: gutter }]}>
              Gegevens: {data.metadataProvider.includes('tmdb') ? 'TMDB' : ''}
              {data.metadataProvider.includes('tmdb') && data.metadataProvider.includes('tvmaze')
                ? ' en '
                : ''}
              {data.metadataProvider.includes('tvmaze') ? 'TVmaze (CC BY-SA 4.0)' : ''}
            </Text>
          ) : null}
        </View>
      </ScrollView>
      <IconButton
        icon="back"
        label="Terug"
        onPress={() => router.back()}
        style={{
          position: 'absolute',
          top: insets.top + 6,
          left: 8,
          backgroundColor: colors.scrim,
        }}
      />
      {removing && (
        <RemoveSheet
          itemId={data.id}
          target={removing}
          onClose={() => setRemoving(undefined)}
          {...(removing.scope === 'title' && { onRemoved: () => router.back() })}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  more: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  moreText: { color: colors.text2, fontWeight: '600', fontSize: 14 },
  manage: {
    marginHorizontal: gutter,
    padding: 16,
    gap: 10,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  removeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 46,
    borderRadius: radius.s,
    borderWidth: 1,
    borderColor: 'rgba(240,138,122,0.5)',
  },
  removeText: { color: colors.danger, fontSize: 16, fontWeight: '700' },
  info: { paddingHorizontal: gutter, gap: 10, marginTop: -40 },
  title: { color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -0.4 },
  facts: { fontSize: 14, color: colors.text2, fontWeight: '600' },
  resume: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nextAir: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Three buttons don't fit next to each other on a narrow phone: then the last wraps.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: { flex: 1, minWidth: 140 },
  // In a car: a column on the left of the wide screen, buttons as wide as their text.
  carInfo: { maxWidth: carLayout.column + 2 * gutter, marginTop: -110 },
  carPlay: { alignSelf: 'flex-start', minWidth: 320 },
  carActions: { justifyContent: 'flex-start' },
  carAction: { minWidth: 160 },
  // Episode lines that stay readable on a wide screen.
  carSeasons: { maxWidth: 1100 + 2 * gutter },
  carStill: { width: 200 },
  seasonHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  seasonPick: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  episode: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    paddingBottom: 14,
    gap: 8,
  },
  episodeMain: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 44 },
  still: {
    width: 140,
    aspectRatio: 16 / 9,
    borderRadius: radius.s,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  stillPlay: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -16,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(5,9,26,0.55)',
    borderWidth: 1.5,
    borderColor: 'rgba(242,244,250,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  stillProgress: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  episodeTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  episodeOverview: { color: colors.text2, fontSize: 13, lineHeight: 19 },
  episodeWatched: { position: 'absolute', right: 0, top: 6 },
  scrim: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'center', padding: 32 },
  seasonList: {
    backgroundColor: colors.surface2,
    borderRadius: radius.l,
    padding: 12,
    maxHeight: '70%',
  },
  seasonOption: { paddingVertical: 12, paddingHorizontal: 12, gap: 2 },
});

// The TV has its own screens, for the remote.
export default isTV ? TvItem : ItemScreen;
