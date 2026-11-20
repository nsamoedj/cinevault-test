// The TV's header, as on Netflix and Plex: the backdrop of the title with the
// focus fills the screen and fades into the page on the left and at the
// bottom, with its logo (or name), facts and description on the left.

import { largeImage } from '@cinevault/shared';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect, useState } from 'react';
import { Animated, PixelRatio, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { ProgressBar, TitleLogo } from '../components/ui';
import { useSession } from '../session';
import { colors } from '../theme';
import { type Spot, type SpotStore, useSpot } from './spotlight';
import { tvText } from './ui';

/** The backdrop follows the focus after this pause, not on every step along a row. */
const BACKDROP_DELAY_MS = 320;

/** The backdrop of the store's title, cross-fading to the next one. */
export function HeroBackdrop({ store, dim }: { store: SpotStore; dim?: boolean }) {
  const spot = useSpot(store);
  const { api, authHeaders } = useSession();
  const { width } = useWindowDimensions();
  const [path, setPath] = useState(spot?.backdropUrl);
  useEffect(() => {
    const timer = setTimeout(() => setPath(spot?.backdropUrl), BACKDROP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [spot?.backdropUrl]);
  // TMDB's full size only for a 4K screen: w1280 is plenty for 1080p.
  const uri = api.resolveUrl(width * PixelRatio.get() > 2000 ? largeImage(path) : path);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {uri ? (
        <Image
          source={{ uri, headers: authHeaders }}
          style={styles.backdrop}
          contentFit="cover"
          contentPosition="top right"
          transition={{ duration: 450, effect: 'cross-dissolve' }}
          cachePolicy="disk"
        />
      ) : null}
      <LinearGradient
        colors={[colors.bg, 'rgba(10,18,48,0.92)', 'rgba(10,18,48,0.45)', 'rgba(10,18,48,0)']}
        locations={[0, 0.28, 0.55, 0.8]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['rgba(10,18,48,0)', 'rgba(10,18,48,0.75)', colors.bg]}
        locations={[0.3, 0.62, 0.86]}
        style={StyleSheet.absoluteFill}
      />
      {dim ? <View style={[StyleSheet.absoluteFill, styles.dim]} /> : null}
    </View>
  );
}

/** Fades in when it appears: a new title in the header. */
function FadeIn({ children }: { children: ReactNode }) {
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, [opacity]);
  return <Animated.View style={{ opacity, gap: 8 }}>{children}</Animated.View>;
}

/** 4K, HDR10, 5.1: small outlined labels. */
export function Badges({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <View style={styles.badges}>
      {list.map((badge) => (
        <Text key={badge} style={styles.badge}>
          {badge}
        </Text>
      ))}
    </View>
  );
}

export function HeroText({
  spot,
  size = 'small',
  lines,
}: {
  spot: Spot;
  /** Large on the billboard and a title's page; small above the rows. */
  size?: 'large' | 'small';
  /** Lines of the description. */
  lines?: number;
}) {
  const { width, height } = useWindowDimensions();
  const large = size === 'large';
  return (
    <FadeIn key={spot.key}>
      {spot.eyebrow ? <Text style={tvText.eyebrow}>{spot.eyebrow}</Text> : null}
      <TitleLogo
        path={spot.logoUrl}
        title={spot.title}
        width={Math.round(width * (large ? 0.34 : 0.27))}
        height={Math.round(height * (large ? 0.17 : 0.12))}
        align="left"
        textStyle={large ? styles.titleLarge : styles.title}
        numberOfLines={2}
      />
      {spot.facts.length > 0 || spot.badges?.length ? (
        <View style={styles.factRow}>
          {spot.facts.length > 0 && (
            <Text style={styles.facts} numberOfLines={1}>
              {spot.facts.join('   ·   ')}
            </Text>
          )}
          <Badges list={spot.badges ?? []} />
        </View>
      ) : null}
      {spot.line ? (
        <Text style={styles.line} numberOfLines={1}>
          {spot.line}
        </Text>
      ) : null}
      {spot.progress ? <ProgressBar share={spot.progress} style={styles.progress} /> : null}
      {spot.overview ? (
        <Text style={styles.overview} numberOfLines={lines ?? (large ? 3 : 2)}>
          {spot.overview}
        </Text>
      ) : null}
    </FadeIn>
  );
}

/** The store's title as text: for the header above the rows. */
export function HeroInfo({ store, size }: { store: SpotStore; size?: 'large' | 'small' }) {
  const spot = useSpot(store);
  return spot ? <HeroText spot={spot} size={size} /> : null;
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, right: 0, width: '82%', height: '86%' },
  dim: { backgroundColor: 'rgba(10,18,48,0.35)' },
  titleLarge: { color: colors.text, fontSize: 44, fontWeight: '900', letterSpacing: -0.6 },
  title: { color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -0.4 },
  factRow: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  facts: { color: colors.text2, fontSize: 15, fontWeight: '700' },
  badges: { flexDirection: 'row', gap: 6 },
  badge: {
    color: colors.text2,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: 3,
  },
  line: { color: colors.text, fontSize: 16, fontWeight: '700' },
  progress: { width: 240, borderRadius: 2 },
  overview: { color: colors.text2, fontSize: 16, lineHeight: 23 },
});
