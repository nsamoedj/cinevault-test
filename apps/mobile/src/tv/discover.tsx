// "Ontdekken" on the TV: a poster for the remote's focus, which opens the title.

import type { DiscoverItem } from '@cinevault/shared';
import { router } from 'expo-router';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { ServerImage } from '../components/ui';
import { cardFlag, kindLabel, titleRoute } from '../discover';
import { colors } from '../theme';
import { noFocusStyle, TvPressable } from './focus';
import { CardFrame } from './ui';

export function TvDiscoverCard({
  item,
  width,
  autoFocus,
  titled,
  onFocus,
  sub,
  current,
}: {
  item: DiscoverItem;
  width: number;
  autoFocus?: boolean;
  /** The title under the poster; without, the screen's header shows it. */
  titled?: boolean;
  onFocus?: () => void;
  /** Instead of "2021 · Film". */
  sub?: string;
  /** The title whose page is open (in its collection's row): OK does nothing. */
  current?: boolean;
}) {
  const flag = cardFlag(item);
  return (
    <TvPressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}${item.year ? `, ${item.year}` : ''}, ${sub ?? kindLabel(item)}`}
      // Still focusable when current, so the row can be walked through.
      onPress={() => {
        if (!current) router.push(titleRoute(item));
      }}
      onFocus={onFocus}
      autoFocus={autoFocus}
      focusStyle={noFocusStyle}
      style={{ width }}
    >
      {({ focused }) => (
        <>
          <CardFrame focused={focused} width={width} ratio={1.5}>
            <ServerImage
              path={item.posterUrl}
              style={StyleSheet.absoluteFill as ViewStyle}
              fallback={item.title}
            />
            {flag && (
              <View style={[styles.flag, item.itemId ? styles.here : styles.asked]}>
                <Text style={[styles.flagText, !item.itemId && { color: colors.text }]}>
                  {flag}
                </Text>
              </View>
            )}
          </CardFrame>
          {titled && (
            <>
              <Text style={[styles.title, focused && { color: colors.text }]} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={[styles.sub, current && { color: colors.brass }]}>
                {sub ?? [item.year, kindLabel(item)].filter(Boolean).join(' · ')}
              </Text>
            </>
          )}
        </>
      )}
    </TvPressable>
  );
}

const styles = StyleSheet.create({
  flag: {
    position: 'absolute',
    top: 8,
    left: 8,
    maxWidth: '88%',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  here: { backgroundColor: '#8fd19e' },
  asked: { backgroundColor: 'rgba(10,18,48,0.85)' },
  flagText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  title: {
    color: colors.text2,
    fontWeight: '600',
    fontSize: 15,
    marginTop: 10,
    paddingHorizontal: 2,
  },
  sub: { color: colors.text3, fontSize: 13, paddingHorizontal: 2 },
});
