import type { DiscoverItem } from '@cinevault/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { cardFlag, kindLabel, titleRoute } from '../discover';
import { colors, radius } from '../theme';
import { ServerImage } from './ui';

/** A poster in "Ontdekken"; a tap opens the title's details. */
export function DiscoverCard({
  item,
  width,
  sub,
  current,
}: {
  item: DiscoverItem;
  width: number;
  /** Instead of "2021 · Film". */
  sub?: string;
  /** The title whose details are open (in its collection's row): not a link. */
  current?: boolean;
}) {
  const flag = cardFlag(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}${item.year ? ` (${item.year})` : ''}, ${sub ?? kindLabel(item)}`}
      accessibilityState={{ selected: Boolean(current) }}
      disabled={current}
      onPress={() => router.push(titleRoute(item))}
      style={({ pressed }) => [{ width }, pressed && { opacity: 0.8 }]}
    >
      <View style={[styles.image, current && styles.current, { width, height: width * 1.5 }]}>
        <ServerImage
          path={item.posterUrl}
          style={StyleSheet.absoluteFill as ViewStyle}
          fallback={item.title}
        />
        {flag && (
          <View style={[styles.flag, item.itemId ? styles.here : styles.asked]}>
            <Text style={[styles.flagText, !item.itemId && { color: colors.text }]}>{flag}</Text>
          </View>
        )}
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {item.title}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {sub ?? [item.year, kindLabel(item)].filter(Boolean).join(' · ')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  image: { borderRadius: radius.s, overflow: 'hidden', backgroundColor: colors.surface },
  flag: {
    position: 'absolute',
    top: 6,
    left: 6,
    maxWidth: '90%',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  current: { borderWidth: 2, borderColor: colors.brass },
  here: { backgroundColor: '#8fd19e' },
  asked: { backgroundColor: 'rgba(10,18,48,0.85)' },
  flagText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  title: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 6 },
  sub: { color: colors.text3, fontSize: 12 },
});
