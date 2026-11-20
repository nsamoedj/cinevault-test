// The frame of the admin screens (Beheer) on a phone or tablet: a title with
// a back button, the page in panels, and the attention count. Only admins get
// here; the screens say so themselves when someone else does (a link from an
// old notification).

import type { ItemSummary, LibrarySummary } from '@cinevault/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { px } from '../car';
import { Icon, type IconName } from '../components/Icon';
import { IconButton, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, gutter, radius } from '../theme';

/** Wider than this, the page is a column in the middle (a tablet). */
const MAX_WIDTH = 760;

export function AdminScreen({ title, children }: { title: string; children: ReactNode }) {
  const { user } = useSession();
  const { width } = useWindowDimensions();
  const side = Math.max(px(gutter), (width - px(MAX_WIDTH)) / 2);
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={[styles.head, { paddingHorizontal: Math.max(px(8), side - px(gutter) + px(8)) }]}
      >
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <View>
          <Text style={styles.eyebrow}>Beheer</Text>
          <Text style={text.h1}>{title}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={[styles.page, { paddingHorizontal: side }]}>
        {user?.role === 'ADMIN' ? (
          children
        ) : (
          <Text style={text.muted}>Dit is alleen voor beheerders.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={styles.panel}>
      {title ? <Text style={text.h2}>{title}</Text> : null}
      {children}
    </View>
  );
}

/** A row that opens another admin screen. */
export function AdminLink({
  icon,
  title,
  sub,
  badge,
  onPress,
}: {
  icon: IconName;
  title: string;
  sub: string;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${title}, ${badge}` : title}
      onPress={onPress}
      style={({ pressed }) => [styles.panel, styles.link, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.linkIcon}>
        <Icon name={icon} size={22} color={colors.brass} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text.h2}>{title}</Text>
        <Text style={text.muted}>{sub}</Text>
      </View>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      <Icon name="chevronRight" size={20} color={colors.text3} />
    </Pressable>
  );
}

const STATUSES = ['UNMATCHED', 'FAILED'] as const;

/** The titles without a match (or whose metadata failed), per library, as on the web. */
export function useAttention(): {
  rows: { item: ItemSummary; library: LibrarySummary }[];
  pending: boolean;
  error: unknown;
  refetch: () => void;
} {
  const { api } = useSession();
  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const pairs = (libraries.data ?? []).flatMap((library) =>
    STATUSES.map((status) => ({ library, status })),
  );
  const results = useQueries({
    queries: pairs.map(({ library, status }) => ({
      queryKey: keys.attention(library.id, status),
      queryFn: () => api.items(library.id, { status, pageSize: 200 }),
    })),
  });
  return {
    rows: pairs.flatMap(({ library }, i) =>
      (results[i]?.data?.items ?? []).map((item) => ({ item, library })),
    ),
    pending: libraries.isPending || results.some((r) => r.isPending),
    error: libraries.error ?? results.find((r) => r.isError)?.error,
    refetch: () => {
      void libraries.refetch();
      for (const r of results) void r.refetch();
    },
  };
}

export const adminStyles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  error: { fontSize: 14, color: colors.danger },
  line: { color: colors.text, fontSize: 15, lineHeight: 22 },
});

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 6 },
  eyebrow: {
    color: colors.brass,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  page: { paddingVertical: 12, gap: 14, paddingBottom: 40 },
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 10,
  },
  link: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  linkIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brassSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 8,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.ink, fontWeight: '800', fontSize: 13 },
});
