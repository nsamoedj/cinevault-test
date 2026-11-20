// Beheer → Aandacht nodig, for admins: titles without a convincing match, or
// whose metadata failed, each with the search to pick the right one.

import type { ItemSummary, LibrarySummary } from '@cinevault/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { MatchPanel } from '../admin/MatchPanel';
import { adminStyles, AdminScreen, Panel, useAttention } from '../admin/ui';
import { Icon } from '../components/Icon';
import { Button, errorText, ServerImage, text } from '../components/ui';
import { colors, radius } from '../theme';

function Row({ item, library }: { item: ItemSummary; library: LibrarySummary }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <ServerImage path={item.posterUrl} style={styles.poster} fallback={item.title} />
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push(`/item/${item.id}`)}
          style={{ flex: 1, gap: 3 }}
        >
          <Text style={styles.title} numberOfLines={2}>
            {item.title}
            {item.year ? ` (${item.year})` : ''}
          </Text>
          <Text style={text.small}>
            {library.name} ·{' '}
            {item.metadataStatus === 'FAILED' ? 'ophalen mislukt' : 'niet gematcht'}
          </Text>
          {item.metadataError ? (
            <Text style={text.small} numberOfLines={2}>
              {item.metadataError}
            </Text>
          ) : null}
        </Pressable>
      </View>
      <Button
        label={open ? 'Sluiten' : 'Match zoeken'}
        icon={open ? 'close' : 'search'}
        kind="secondary"
        onPress={() => setOpen((o) => !o)}
      />
      {open && <MatchPanel item={item} onDone={() => setOpen(false)} />}
    </View>
  );
}

function AttentionScreen() {
  const attention = useAttention();
  return (
    <AdminScreen title="Aandacht nodig">
      <Text style={text.muted}>
        Titels waarvoor geen overtuigende match is gevonden, of waarvan het ophalen mislukte.
        Mislukte titels worden bij de volgende scan vanzelf opnieuw geprobeerd.
      </Text>
      {attention.pending ? (
        <ActivityIndicator color={colors.brass} style={{ marginTop: 24 }} />
      ) : attention.error ? (
        <Panel>
          <Text style={adminStyles.error}>{errorText(attention.error)}</Text>
          <Button label="Opnieuw" kind="secondary" onPress={attention.refetch} />
        </Panel>
      ) : attention.rows.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="check" size={40} color={colors.ok} />
          <Text style={[text.body, { color: colors.ok }]}>Alles is gematcht.</Text>
        </View>
      ) : (
        attention.rows.map(({ item, library }) => (
          <Row key={item.id} item={item} library={library} />
        ))
      )}
    </AdminScreen>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 10,
    padding: 12,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  head: { flexDirection: 'row', gap: 12 },
  poster: { width: 56, height: 84, borderRadius: radius.s },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 40 },
});

export default AttentionScreen;
