// The TV's menu, as on Netflix: a narrow column of icons on the left. When
// the remote's focus goes into it ("left" from the first card), it opens
// over the page with the names, and the page dims behind it.
//
// Each entry is only as wide as the closed menu, so that the focus search
// from the page reaches it with "left"; the name and the highlight are drawn
// outside it.

import type { LibrarySummary, LibraryType } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Avatar } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { libraryLabel } from '../format';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { noFocusStyle, TvPressable } from './focus';
import { NAV_WIDTH } from './ui';

const OPEN_WIDTH = 270;

const ITEMS: Record<string, { icon: IconName; label: string }> = {
  index: { icon: 'home', label: 'Home' },
  search: { icon: 'search', label: 'Zoeken' },
  discover: { icon: 'compass', label: 'Ontdekken' },
  profile: { icon: 'user', label: 'Profiel' },
};

const LIBRARY_ICON: Record<LibraryType, IconName> = {
  MOVIES: 'film',
  SHOWS: 'tv',
  ANIME: 'sparkle',
};

function NavItem({
  icon,
  label,
  on,
  open,
  onPress,
  onFocus,
  onBlur,
}: {
  icon: IconName;
  label: string;
  on: boolean;
  open: Animated.Value;
  onPress: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <TvPressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      focusStyle={noFocusStyle}
      style={styles.item}
    >
      {({ focused }) => (
        <>
          {focused && <View style={styles.highlight} />}
          {on && !focused && <View style={styles.marker} />}
          <Icon
            name={icon}
            size={26}
            color={focused ? colors.ink : on ? colors.brass : colors.text2}
          />
          {/* The entry itself carries the name (accessibilityLabel). */}
          <Animated.Text
            importantForAccessibility="no"
            style={[
              styles.label,
              on && { color: colors.brass },
              focused && { color: colors.ink },
              { opacity: open },
            ]}
            numberOfLines={1}
          >
            {label}
          </Animated.Text>
        </>
      )}
    </TvPressable>
  );
}

/**
 * Home, then each library (Films, Series, Anime) as its own entry, so the
 * remote goes straight to one; then search, Ontdekken and the profile.
 */
export function TvNav({ state, descriptors, navigateToTab }: BottomTabBarProps) {
  const { api, user } = useSession();
  const { width } = useWindowDimensions();
  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const all: LibrarySummary[] = libraries.data ?? [];
  const current = state.routes[state.index];
  const shown =
    current?.name === 'library'
      ? ((current.params as { id?: string } | undefined)?.id ?? all[0]?.id)
      : undefined;

  // Open while one of the entries has the focus; moving between them blurs one
  // and focuses the next, so closing waits a moment.
  const [open] = useState(() => new Animated.Value(0));
  const [isOpen, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    Animated.timing(open, {
      toValue: isOpen ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [isOpen, open]);
  useEffect(() => () => clearTimeout(closing.current), []);
  const onFocus = () => {
    clearTimeout(closing.current);
    setOpen(true);
  };
  const onBlur = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), 60);
  };
  const focus = { open, onFocus, onBlur };

  return (
    <View style={styles.nav}>
      {/* The open menu and the dimmed page, drawn over the page. */}
      <Animated.View pointerEvents="none" style={[styles.overlay, { width, opacity: open }]}>
        <LinearGradient
          colors={[colors.bg, 'rgba(10,18,48,0.94)', 'rgba(10,18,48,0.55)']}
          locations={[0, OPEN_WIDTH / width, Math.min(1, (OPEN_WIDTH + 260) / width)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <View style={styles.strip} pointerEvents="none" />

      <View style={styles.brand}>
        {user ? (
          <Avatar name={user.displayName} color={user.avatarColor} size={36} />
        ) : (
          <Text style={styles.brandText}>
            C<Text style={{ color: colors.brass }}>V</Text>
          </Text>
        )}
        <Animated.Text style={[styles.brandName, { opacity: open }]} numberOfLines={1}>
          {user?.displayName ?? 'CineVault'}
        </Animated.Text>
      </View>

      <View style={styles.items}>
        {state.routes.map((route, index) => {
          if (route.name === 'library') {
            return all.map((library) => (
              <NavItem
                key={library.id}
                icon={LIBRARY_ICON[library.type]}
                label={libraryLabel(library, all)}
                on={library.id === shown}
                {...focus}
                // The tab's own navigation: to the library tab, with only this id
                // as its params (a new library starts in A-Z, all genres).
                onPress={() =>
                  descriptors[route.key]?.navigation.navigate('library', { id: library.id })
                }
              />
            ));
          }
          const item = ITEMS[route.name];
          // A kids profile can't ask for titles: no Ontdekken.
          if (!item || (route.name === 'discover' && user?.maxAge !== undefined)) return null;
          return (
            <NavItem
              key={route.key}
              icon={item.icon}
              label={item.label}
              on={index === state.index}
              {...focus}
              onPress={() => navigateToTab(route.key)}
            />
          );
        })}
      </View>
      <Animated.Text style={[styles.wordmark, { opacity: open }]}>
        Cine<Text style={{ color: colors.brass }}>Vault</Text>
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Above the page, which comes after it: the open menu is drawn over it.
  nav: { width: NAV_WIDTH, zIndex: 10, elevation: 10, paddingTop: 30, paddingBottom: 24 },
  overlay: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  strip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(10,18,48,0.88)',
  },
  brand: { width: NAV_WIDTH, height: 44, alignItems: 'center', justifyContent: 'center' },
  brandText: { color: colors.text, fontSize: 22, fontWeight: '900' },
  brandName: {
    position: 'absolute',
    left: NAV_WIDTH - 4,
    width: OPEN_WIDTH - NAV_WIDTH,
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  items: { flex: 1, justifyContent: 'center', gap: 6 },
  item: { width: NAV_WIDTH, height: 48, alignItems: 'center', justifyContent: 'center' },
  highlight: {
    position: 'absolute',
    left: 10,
    top: 0,
    bottom: 0,
    width: OPEN_WIDTH - 24,
    borderRadius: radius.m,
    backgroundColor: colors.brass,
  },
  marker: {
    position: 'absolute',
    left: 0,
    top: 12,
    bottom: 12,
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.brass,
  },
  label: {
    position: 'absolute',
    left: NAV_WIDTH - 4,
    width: OPEN_WIDTH - NAV_WIDTH - 16,
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  wordmark: {
    position: 'absolute',
    bottom: 24,
    left: 24,
    width: OPEN_WIDTH,
    color: colors.text,
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
});
