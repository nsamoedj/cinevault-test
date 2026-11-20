import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { carLayout, isCar, px } from '../../car';
import { Icon, type IconName } from '../../components/Icon';
import { SideMenuWidth } from '../../components/sizes';
import { isTV } from '../../tv/focus';
import { TvNav } from '../../tv/TvNav';
import { useSession } from '../../session';
import { colors } from '../../theme';

const tab = (icon: IconName, title: string) => ({
  title,
  tabBarIcon: ({ color }: { color: unknown }) => (
    <Icon name={icon} size={24} color={typeof color === 'string' ? color : colors.text3} />
  ),
});

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  // A kids profile can't ask for titles: no Ontdekken.
  const kids = useSession().user?.maxAge !== undefined;
  return (
    // Grids and rows measure the screen next to the rail.
    <SideMenuWidth.Provider value={isCar ? px(carLayout.rail) : 0}>
      <Tabs
        // On a TV the menu is a column on the left, for the remote.
        {...(isTV && { tabBar: (props) => <TvNav {...props} /> })}
        screenOptions={{
          headerShown: false,
          ...(isTV && { tabBarPosition: 'left' as const }),
          tabBarActiveTintColor: colors.brass,
          tabBarInactiveTintColor: colors.text3,
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          tabBarStyle: {
            backgroundColor: 'rgba(10,18,48,0.97)',
            borderTopColor: colors.line,
            height: 60 + insets.bottom,
            paddingTop: 6,
          },
          // In a car a rail on the left, at the driver's side: the bottom of the
          // screen is the car's own bar, and the wide screen has room to spare.
          ...(isCar && {
            tabBarPosition: 'left' as const,
            tabBarVariant: 'material' as const,
            // A narrow rail with the label under the icon, not a wide sidebar.
            tabBarLabelPosition: 'below-icon' as const,
            tabBarLabelStyle: { fontSize: px(12), fontWeight: '600' },
            tabBarStyle: {
              backgroundColor: 'rgba(10,18,48,0.97)',
              borderRightColor: colors.line,
              width: px(carLayout.rail),
            },
            tabBarItemStyle: { minHeight: px(68) },
          }),
          sceneStyle: {
            backgroundColor: colors.bg,
            // The car's own bar (climate) lies over the bottom of the screen:
            // the last row scrolls up above it.
            ...(isCar && { paddingBottom: insets.bottom }),
          },
        }}
      >
        <Tabs.Screen name="index" options={tab('home', 'Home')} />
        <Tabs.Screen name="library" options={tab('film', 'Bibliotheek')} />
        <Tabs.Screen name="search" options={tab('search', 'Zoeken')} />
        <Tabs.Screen
          name="discover"
          options={{ ...tab('compass', 'Ontdekken'), ...(kids && { href: null }) }}
        />
        <Tabs.Screen name="profile" options={tab('user', 'Profiel')} />
      </Tabs>
    </SideMenuWidth.Provider>
  );
}
