// "Ontdekken" on a phone or tablet: ask for some seasons, or single episodes,
// of a show instead of all of it. What is here or asked for can't be picked.

import {
  type DiscoverItem,
  type DiscoverSeason,
  type MediaRequestDto,
  requestPartsLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { Icon } from './Icon';
import { Button, errorText, text } from './ui';

const episodeKey = (season: number, episode: number) => `${season}:${episode}`;

function seasonState(season: DiscoverSeason): string {
  if (season.episodeCount > 0 && season.inLibrary >= season.episodeCount) return 'Staat er al';
  if (season.requested) return 'Aangevraagd';
  if (season.inLibrary > 0) return `${season.inLibrary} van ${season.episodeCount} hier`;
  return `${season.episodeCount} ${season.episodeCount === 1 ? 'aflevering' : 'afleveringen'}`;
}

function Check({
  label,
  detail,
  checked,
  disabled,
  onPress,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.check, disabled && { opacity: 0.55 }]}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked && <Icon name="check" size={16} color={colors.ink} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.label} numberOfLines={2}>
          {label}
        </Text>
        {detail ? <Text style={text.small}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

function Episodes({
  tmdbId,
  seasonNumber,
  whole,
  picked,
  onToggle,
}: {
  tmdbId: number;
  seasonNumber: number;
  whole: boolean;
  picked: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { api } = useSession();
  const season = useQuery({
    queryKey: ['discover', 'season', tmdbId, seasonNumber],
    queryFn: () => api.discoverSeason(tmdbId, seasonNumber),
  });
  if (season.isPending) return <ActivityIndicator color={colors.brass} />;
  if (season.isError) return <Text style={styles.error}>{errorText(season.error)}</Text>;
  return (
    <View style={styles.episodes}>
      {season.data.episodes.map((episode) => {
        const key = episodeKey(episode.seasonNumber, episode.episodeNumber);
        const done = episode.inLibrary || episode.requested;
        return (
          <Check
            key={key}
            label={`A${episode.episodeNumber}${episode.title ? ` · ${episode.title}` : ''}`}
            detail={
              episode.inLibrary
                ? 'Staat er al'
                : episode.requested
                  ? 'Aangevraagd'
                  : episode.upcoming
                    ? 'Binnenkort'
                    : undefined
            }
            checked={done || whole || picked.has(key)}
            disabled={done || whole}
            onPress={() => onToggle(key)}
          />
        );
      })}
    </View>
  );
}

export function SeasonPicker({
  item,
  seasons,
  onAsked,
}: {
  item: DiscoverItem;
  seasons: DiscoverSeason[];
  onAsked: (request: MediaRequestDto) => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [whole, setWhole] = useState<Set<number>>(new Set());
  const [episodes, setEpisodes] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<number>();
  const chosen = {
    seasons: [...whole],
    episodes: [...episodes]
      .map((key) => {
        const [seasonNumber = 0, episodeNumber = 0] = key.split(':').map(Number);
        return { seasonNumber, episodeNumber };
      })
      .filter((e) => !whole.has(e.seasonNumber)),
  };
  const label = requestPartsLabel(chosen);
  const ask = useMutation({
    mutationFn: () =>
      api.createRequest({ kind: 'show', tmdbId: item.tmdbId, anime: item.anime, ...chosen }),
    onSuccess: (request) => {
      setWhole(new Set());
      setEpisodes(new Set());
      onAsked(request);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['discover'] }),
        queryClient.invalidateQueries({ queryKey: keys.requests }),
      ]),
  });
  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <View style={styles.picker}>
      <Text style={text.h2}>Seizoenen of afleveringen</Text>
      {seasons.map((season) => {
        const done =
          season.requested || (season.episodeCount > 0 && season.inLibrary >= season.episodeCount);
        const expanded = open === season.seasonNumber;
        return (
          <View key={season.seasonNumber} style={styles.season}>
            <View style={styles.seasonRow}>
              <View style={{ flex: 1 }}>
                <Check
                  label={season.name ?? `Seizoen ${season.seasonNumber}`}
                  detail={seasonState(season)}
                  checked={done || whole.has(season.seasonNumber)}
                  disabled={done}
                  onPress={() => setWhole((current) => toggle(current, season.seasonNumber))}
                />
              </View>
              {!done && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Afleveringen van seizoen ${season.seasonNumber}`}
                  accessibilityState={{ expanded }}
                  onPress={() => setOpen(expanded ? undefined : season.seasonNumber)}
                  style={styles.expand}
                >
                  <Icon
                    name={expanded ? 'chevronUp' : 'chevronDown'}
                    size={22}
                    color={colors.text}
                  />
                </Pressable>
              )}
            </View>
            {expanded && (
              <Episodes
                tmdbId={item.tmdbId}
                seasonNumber={season.seasonNumber}
                whole={whole.has(season.seasonNumber)}
                picked={episodes}
                onToggle={(key) => setEpisodes((current) => toggle(current, key))}
              />
            )}
          </View>
        );
      })}
      <Button
        label={label ? `${label} aanvragen` : 'Kies wat je wilt aanvragen'}
        icon="plus"
        disabled={!label || ask.isPending}
        onPress={() => ask.mutate()}
      />
      {ask.isError && <Text style={styles.error}>{errorText(ask.error)}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { gap: 8, marginTop: 8 },
  season: { borderRadius: radius.m, backgroundColor: colors.surface, padding: 6 },
  seasonRow: { flexDirection: 'row', alignItems: 'center' },
  expand: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  episodes: { paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: colors.line, marginLeft: 20 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, padding: 6 },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.text2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.brass, borderColor: colors.brass },
  label: { fontSize: 14, color: colors.text, fontWeight: '700' },
  error: { fontSize: 14, color: '#f08a7a' },
});
