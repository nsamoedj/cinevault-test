// The admin part of a title's page on a phone or tablet: correcting the match,
// undoing a match set by hand, turning the theme music off or on, and a show's
// intro, recap and credits per episode (markers.tsx).

import type { ItemDetails } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '../components/Icon';
import { errorText, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { MatchPanel } from './MatchPanel';
import { adminStyles } from './ui';

function Action({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.action,
        pressed && { opacity: 0.8 },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Icon name={icon} size={20} color={colors.text} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

export function ItemAdmin({ item }: { item: ItemDetails }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [matching, setMatching] = useState(false);
  const unmatch = useMutation({
    mutationFn: () => api.clearMatch(item.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.item(item.id), updated);
      void queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });
  // Shares the query with the theme music itself (themeMusic.ts).
  const theme = useQuery({
    queryKey: keys.theme(item.id),
    queryFn: () => api.theme(item.id),
    staleTime: 60_000,
  });
  const themeChoice = useMutation({
    mutationFn: (off: boolean) => api.setTheme(item.id, { off }),
    onSuccess: (next) => queryClient.setQueryData(keys.theme(item.id), next),
  });
  const failed = unmatch.error ?? themeChoice.error;
  const firstSeason = [...(item.seasons ?? [])]
    .filter((s) => s.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
  return (
    <View style={{ gap: 8 }}>
      <Action
        icon={matching ? 'close' : 'search'}
        label={matching ? 'Match sluiten' : 'Match corrigeren'}
        onPress={() => setMatching((m) => !m)}
      />
      {matching && <MatchPanel item={item} onDone={() => setMatching(false)} />}
      {item.matchLocked && (
        <Action
          icon="close"
          label="Match ongedaan maken"
          disabled={unmatch.isPending}
          onPress={() => unmatch.mutate()}
        />
      )}
      {theme.data && (theme.data.off || theme.data.from) && (
        <Action
          icon="volume"
          label={theme.data.off ? 'Themamuziek aanzetten' : 'Themamuziek uitzetten'}
          disabled={themeChoice.isPending}
          onPress={() => themeChoice.mutate(!theme.data?.off)}
        />
      )}
      {item.type === 'SHOW' && firstSeason && (
        <Action
          icon="next"
          label="Intro, recap en aftiteling per aflevering"
          onPress={() => router.push({ pathname: '/markers', params: { season: firstSeason.id } })}
        />
      )}
      {failed ? <Text style={adminStyles.error}>{errorText(failed)}</Text> : null}
      <Text style={text.small}>
        Een intro, recap of aftiteling corrigeer je in de speler, onder Instellingen.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: radius.s,
    backgroundColor: colors.glass,
  },
  actionText: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
