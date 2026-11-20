// Search TMDB (and TVmaze) and pick the right title for an item, as the web's
// MatchPanel: on Aandacht nodig, and on a title's page (Match corrigeren).

import type { MatchCandidate } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button, errorText, Input, ServerImage, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { adminStyles } from './ui';

const PROVIDER = { tmdb: 'TMDB', tvmaze: 'TVmaze' } as const;

export function MatchPanel({
  item,
  onDone,
}: {
  item: { id: string; title: string; year?: number };
  onDone?: () => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(item.title);
  const [year, setYear] = useState(item.year ? String(item.year) : '');
  const [query, setQuery] = useState<{ title: string; year?: number }>({
    title: item.title,
    ...(item.year && { year: item.year }),
  });
  const candidates = useQuery({
    queryKey: keys.candidates(item.id, query.title, query.year),
    queryFn: () => api.candidates(item.id, query),
  });
  const choose = useMutation({
    mutationFn: (candidate: MatchCandidate) =>
      api.setMatch(item.id, { provider: candidate.provider, id: candidate.id }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.item(item.id) }),
        queryClient.invalidateQueries({ queryKey: ['items'] }),
        queryClient.invalidateQueries({ queryKey: keys.libraries }),
      ]);
      onDone?.();
    },
  });
  const search = () => {
    const parsed = Number(year);
    setQuery({
      title: title.trim() || item.title,
      ...(year && parsed > 1800 && { year: parsed }),
    });
  };

  return (
    <View style={styles.panel}>
      <View style={styles.form}>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder="Titel"
          accessibilityLabel="Titel"
          returnKeyType="search"
          onSubmitEditing={search}
          style={[styles.input, { flex: 1 }]}
        />
        <Input
          value={year}
          onChangeText={setYear}
          placeholder="Jaar"
          accessibilityLabel="Jaar"
          keyboardType="number-pad"
          maxLength={4}
          returnKeyType="search"
          onSubmitEditing={search}
          style={[styles.input, { width: 76 }]}
        />
      </View>
      <Button label="Zoeken" icon="search" kind="secondary" onPress={search} />
      {candidates.isPending ? (
        <ActivityIndicator color={colors.brass} style={{ marginVertical: 12 }} />
      ) : candidates.isError ? (
        <Text style={adminStyles.error}>{errorText(candidates.error)}</Text>
      ) : candidates.data.length === 0 ? (
        <Text style={text.muted}>
          Geen resultaten. Probeer een andere titel of laat het jaar leeg.
        </Text>
      ) : (
        candidates.data.map((candidate) => (
          <View key={`${candidate.provider}-${candidate.id}`} style={styles.candidate}>
            <ServerImage
              path={candidate.posterUrl}
              style={styles.poster}
              fallback={candidate.title}
            />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.name} numberOfLines={2}>
                {candidate.title}
                {candidate.year ? ` (${candidate.year})` : ''}
              </Text>
              {candidate.originalTitle ? (
                <Text style={text.small} numberOfLines={1}>
                  {candidate.originalTitle}
                </Text>
              ) : null}
              <Text style={styles.tag}>{PROVIDER[candidate.provider]}</Text>
              {candidate.overview ? (
                <Text style={text.small} numberOfLines={3}>
                  {candidate.overview}
                </Text>
              ) : null}
              <Button
                label="Kiezen"
                disabled={choose.isPending}
                onPress={() => choose.mutate(candidate)}
                style={{ alignSelf: 'flex-start', marginTop: 4 }}
              />
            </View>
          </View>
        ))
      )}
      {choose.error ? (
        <Text style={adminStyles.error}>Match niet opgeslagen: {errorText(choose.error)}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 10, paddingTop: 4 },
  form: { flexDirection: 'row', gap: 8 },
  input: {
    minHeight: 48,
    borderRadius: radius.s,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  candidate: {
    flexDirection: 'row',
    gap: 12,
    padding: 10,
    borderRadius: radius.m,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  poster: { width: 64, height: 96, borderRadius: radius.s },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
  tag: {
    alignSelf: 'flex-start',
    color: colors.brass,
    fontSize: 12,
    fontWeight: '800',
    borderWidth: 1,
    borderColor: colors.brass,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
});
