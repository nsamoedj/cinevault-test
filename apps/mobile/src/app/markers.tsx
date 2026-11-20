// Beheer → Intro, recap en aftiteling per aflevering (phone and tablet, admins):
// every episode of a season with its parts on a timeline and how sure the
// search is; one episode's intro (or credits) on the whole season; the
// season looked at again; and the player to set a part by hand (Instellingen).

import {
  type MarkerDto,
  type MarkerKind,
  MARKER_KINDS,
  markerConfidenceLabel,
  MIN_MARKER_CONFIDENCE,
  type SeasonMarkers,
  seasonLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { NAME, SOURCE } from '../admin/IntroEditor';
import { adminStyles, AdminScreen, Panel } from '../admin/ui';
import { Icon } from '../components/Icon';
import { Button, errorText, text } from '../components/ui';
import { clockLabel } from '../format';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';

type Episode = SeasonMarkers['episodes'][number];

const COLOR: Record<MarkerKind, string> = {
  intro: colors.brass,
  recap: '#4F9DE0',
  credits: '#9AA3BF',
  preview: '#B07FE0',
};

const uncertain = (marker: MarkerDto) =>
  marker.confidence !== undefined && marker.confidence < MIN_MARKER_CONFIDENCE;

function Timeline({ episode }: { episode: Episode }) {
  const length =
    episode.durationMs ??
    Math.max(1, ...Object.values(episode.markers).map((m) => (m ? m.endMs : 0)));
  return (
    <View style={styles.timeline}>
      {MARKER_KINDS.map((kind) => {
        const marker = episode.markers[kind];
        if (!marker) return null;
        return (
          <View
            key={kind}
            style={[
              styles.block,
              {
                left: `${(marker.startMs / length) * 100}%`,
                width: `${Math.max(0.8, ((marker.endMs - marker.startMs) / length) * 100)}%`,
                backgroundColor: COLOR[kind],
              },
              uncertain(marker) && { opacity: 0.35 },
            ]}
          />
        );
      })}
    </View>
  );
}

function EpisodeRow({
  episode,
  seasonId,
  onChanged,
}: {
  episode: Episode;
  seasonId: string;
  onChanged: (next: SeasonMarkers) => void;
}) {
  const { api } = useSession();
  const copy = useMutation({
    mutationFn: (kind: 'intro' | 'credits') =>
      api.copyMarker(seasonId, { fileId: episode.fileId, kind }),
    onSuccess: onChanged,
  });
  const ask = (kind: 'intro' | 'credits') =>
    Alert.alert(
      kind === 'intro' ? 'Intro naar alle afleveringen' : 'Aftiteling naar alle afleveringen',
      `${kind === 'intro' ? 'De intro' : 'De aftiteling (vanaf het einde)'} van aflevering ${episode.episodeNumber} met de hand op alle afleveringen van dit seizoen zetten? Wat daar gevonden is, wordt vervangen.`,
      [
        { text: 'Annuleren', style: 'cancel' },
        { text: 'Overnemen', onPress: () => copy.mutate(kind) },
      ],
    );
  const found = MARKER_KINDS.filter((kind) => episode.markers[kind]);
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title} numberOfLines={2}>
            A{episode.episodeNumber}
            {episode.title ? ` · ${episode.title}` : ''}
          </Text>
          {episode.pending.length > 0 && (
            <Text style={text.small}>
              Zoekt nog: {episode.pending.map((kind) => NAME[kind].name).join(', ')}
            </Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Aflevering ${episode.episodeNumber} aanpassen in de speler`}
          onPress={() => router.push(`/play/${episode.fileId}`)}
          style={({ pressed }) => [styles.play, pressed && { opacity: 0.8 }]}
        >
          <Icon name="play" size={18} color={colors.ink} />
        </Pressable>
      </View>
      <Timeline episode={episode} />
      {found.map((kind) => {
        const marker = episode.markers[kind];
        if (!marker) return null;
        const sure = markerConfidenceLabel(marker.confidence);
        return (
          <View key={kind} style={[styles.line, uncertain(marker) && { opacity: 0.7 }]}>
            <View style={[styles.dot, { backgroundColor: COLOR[kind] }]} />
            <Text style={styles.lineText}>
              <Text style={{ fontWeight: '700' }}>{NAME[kind].title}</Text>{' '}
              {clockLabel(marker.startMs / 1000)} tot {clockLabel(marker.endMs / 1000)}
              <Text style={styles.muted}>
                {' '}
                · {SOURCE[marker.source] ?? marker.source}
                {sure ? ` · ${sure}` : ''}
              </Text>
            </Text>
          </View>
        );
      })}
      {found.length === 0 && episode.pending.length === 0 && (
        <Text style={text.small}>Niets gevonden.</Text>
      )}
      {(episode.markers.intro || episode.markers.credits) && (
        <View style={adminStyles.row}>
          {episode.markers.intro && (
            <Button
              label="Intro naar alle"
              kind="secondary"
              disabled={copy.isPending}
              onPress={() => ask('intro')}
            />
          )}
          {episode.markers.credits && (
            <Button
              label="Aftiteling naar alle"
              kind="secondary"
              disabled={copy.isPending}
              onPress={() => ask('credits')}
            />
          )}
        </View>
      )}
      {copy.error ? <Text style={adminStyles.error}>{errorText(copy.error)}</Text> : null}
    </View>
  );
}

export default function MarkersScreen() {
  const { season = '' } = useLocalSearchParams<{ season: string }>();
  const { api } = useSession();
  const queryClient = useQueryClient();
  const markers = useQuery({
    queryKey: keys.seasonMarkers(season),
    queryFn: () => api.seasonMarkers(season),
    enabled: season !== '',
    refetchInterval: (query) =>
      query.state.data?.episodes.some((e) => e.pending.length > 0) ? 15_000 : false,
  });
  const set = (next: SeasonMarkers) => queryClient.setQueryData(keys.seasonMarkers(season), next);
  const detect = useMutation({ mutationFn: () => api.detectSeasonMarkers(season), onSuccess: set });
  const data = markers.data;
  const count = data
    ? data.episodes.reduce(
        (n, e) => n + Object.values(e.markers).filter((m) => m && uncertain(m)).length,
        0,
      )
    : 0;

  return (
    <AdminScreen title="Intro, recap en aftiteling">
      {markers.isPending ? (
        <ActivityIndicator color={colors.brass} />
      ) : markers.error || !data ? (
        <Text style={adminStyles.error}>{errorText(markers.error)}</Text>
      ) : (
        <>
          <Panel title={`${data.title} · ${seasonLabel(data.seasonNumber)}`}>
            {data.seasons.length > 1 && (
              <View style={adminStyles.row}>
                {data.seasons.map((s) => (
                  <Pressable
                    key={s.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: s.id === data.seasonId }}
                    onPress={() => router.setParams({ season: s.id })}
                    style={[styles.chip, s.id === data.seasonId && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, s.id === data.seasonId && styles.chipTextOn]}>
                      {seasonLabel(s.seasonNumber)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <View style={adminStyles.row}>
              {MARKER_KINDS.map((kind) => (
                <View key={kind} style={styles.legend}>
                  <View style={[styles.dot, { backgroundColor: COLOR[kind] }]} />
                  <Text style={text.small}>{NAME[kind].title}</Text>
                </View>
              ))}
            </View>
            <Text style={text.small}>
              Hoe zeker: het deel van de afleveringen waarin de server hetzelfde vond (hoofdstukken
              en AniSkip gelden als zeker). Onder de helft tonen de spelers geen knop; hier vaag.
              Met de hand instellen: ▶ opent de speler, dan Instellingen.
            </Text>
            {count > 0 && (
              <Text style={adminStyles.line}>
                {count === 1 ? '1 deel is' : `${count} delen zijn`} te onzeker voor de spelers.
              </Text>
            )}
            <Button
              label="Seizoen opnieuw zoeken"
              kind="secondary"
              icon="search"
              disabled={detect.isPending}
              onPress={() => detect.mutate()}
            />
            <Text style={text.small}>Niet wat met de hand is ingesteld.</Text>
            {detect.error ? <Text style={adminStyles.error}>{errorText(detect.error)}</Text> : null}
          </Panel>
          {data.episodes.map((episode) => (
            <EpisodeRow
              key={episode.fileId}
              episode={episode}
              seasonId={data.seasonId}
              onChanged={set}
            />
          ))}
        </>
      )}
    </AdminScreen>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    gap: 8,
  },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  play: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeline: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.glass,
    overflow: 'hidden',
  },
  block: { position: 'absolute', top: 0, bottom: 0, borderRadius: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lineText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.text3 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.glass,
  },
  chipOn: { backgroundColor: colors.brass },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  chipTextOn: { color: colors.ink },
});
