import { ageLabel, type CastQuality, QUALITIES, type Quality } from '@cinevault/shared';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../components/Icon';
import { LinkTv } from '../../components/LinkTv';
import { SKIP_LABELS, useProfileSkipSettings } from '../../player/skip';
import { NotificationSettingsPanel } from '../../components/Notifications';
import { ServerAddresses } from '../../components/ServerAddresses';
import { Avatar, Button, text } from '../../components/ui';
import {
  type ThemeLevel,
  useCastQualitySetting,
  useQualitySetting,
  useThemeMusicSetting,
} from '../../preferences';
import { useSession } from '../../session';
import { colors, gutter, radius } from '../../theme';
import { carLayout, isCar, thisDevice } from '../../car';
import { isTV } from '../../tv/focus';
import { TvProfile } from '../../tv/screens/TvProfile';

const QUALITY_LABEL: Record<Quality, string> = {
  original: 'Origineel (zoals het bestand is)',
  '1080p': '1080p (8 Mbit/s)',
  '720p': '720p (4 Mbit/s, voor mobiele data)',
};

const THEME_LEVELS: { id: ThemeLevel; label: string }[] = [
  { id: 'off', label: 'Uit' },
  { id: 'soft', label: 'Zacht' },
  { id: 'normal', label: 'Normaal' },
  { id: 'loud', label: 'Luider' },
];

const CAST_QUALITIES: { id: CastQuality; label: string }[] = [
  { id: 'auto', label: 'Automatisch (naar het model)' },
  { id: '4k', label: '4K (HEVC, HDR)' },
  { id: '1080p', label: '1080p (H.264)' },
];

function ProfileScreen() {
  const { user, signOut } = useSession();
  const [quality, setQuality] = useQualitySetting();
  const [castQuality, setCastQuality] = useCastQualitySetting();
  const [themeLevel, setThemeLevel] = useThemeMusicSetting();
  const skip = useProfileSkipSettings();
  const admin = user?.role === 'ADMIN';
  const kids = user?.maxAge !== undefined;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={[styles.page, isCar && styles.carPage]}>
        {user && (
          <View style={styles.header}>
            <Avatar name={user.displayName} color={user.avatarColor} size={64} />
            <View>
              <Text style={text.h1}>{user.displayName}</Text>
              <Text style={text.muted}>
                {user.username} ·{' '}
                {admin
                  ? 'Beheerder'
                  : kids
                    ? `Kinderprofiel · t/m ${ageLabel(user.maxAge ?? 0)}`
                    : 'Lid'}
              </Text>
            </View>
          </View>
        )}

        {/* Only for admins: members see nothing of it. */}
        {admin && (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/admin')}
            style={({ pressed }) => [styles.panel, styles.link, pressed && { opacity: 0.85 }]}
          >
            <View style={styles.linkIcon}>
              <Icon name="settings" size={22} color={colors.brass} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text.h2}>Beheer</Text>
              <Text style={text.muted}>Scannen, matchen, verzoeken en de stand van de server</Text>
            </View>
            <Icon name="chevronRight" size={20} color={colors.text3} />
          </Pressable>
        )}
        {admin && (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/accounts')}
            style={({ pressed }) => [styles.panel, styles.link, pressed && { opacity: 0.85 }]}
          >
            <View style={styles.linkIcon}>
              <Icon name="user" size={22} color={colors.brass} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text.h2}>Accounts</Text>
              <Text style={text.muted}>Profielen toevoegen, wijzigen en verwijderen</Text>
            </View>
            <Icon name="chevronRight" size={20} color={colors.text3} />
          </Pressable>
        )}

        <View style={styles.panel}>
          <Text style={text.h2}>Kwaliteit</Text>
          <Text style={text.muted}>
            Origineel speelt het bestand af zoals het is, als {thisDevice} dat kan. Kies een lagere
            kwaliteit onderweg, dan zet de server de video om.
          </Text>
          {QUALITIES.map((q) => (
            <Pressable
              key={q.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: quality === q.id }}
              onPress={() => setQuality(q.id)}
              style={[styles.option, quality === q.id && { backgroundColor: colors.brassSoft }]}
            >
              <Text style={text.body}>{QUALITY_LABEL[q.id]}</Text>
              {quality === q.id && <Icon name="check" size={20} color={colors.brass} />}
            </Pressable>
          ))}
        </View>

        {/* No Chromecast in a car. */}
        {!isCar && (
          <View style={styles.panel}>
            <Text style={text.h2}>Chromecast</Text>
            <Text style={text.muted}>
              Een Chromecast Ultra of Chromecast met Google TV speelt 4K. Andere krijgen 1080p. Kies
              zelf als de app jouw Chromecast niet goed herkent.
            </Text>
            {CAST_QUALITIES.map((q) => (
              <Pressable
                key={q.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: castQuality === q.id }}
                onPress={() => setCastQuality(q.id)}
                style={[
                  styles.option,
                  castQuality === q.id && { backgroundColor: colors.brassSoft },
                ]}
              >
                <Text style={text.body}>{q.label}</Text>
                {castQuality === q.id && <Icon name="check" size={20} color={colors.brass} />}
              </Pressable>
            ))}
          </View>
        )}

        {skip.settings && (
          <View style={styles.panel}>
            <Text style={text.h2}>Automatisch overslaan</Text>
            <Text style={text.muted}>
              Voor dit profiel, in elke speler. Spoel je terug, dan zie je de knop weer.
            </Text>
            {SKIP_LABELS.map(({ kind, label }) => (
              <Pressable
                key={kind}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: skip.settings?.[kind] ?? false }}
                onPress={() => skip.toggle(kind)}
                style={[
                  styles.option,
                  skip.settings?.[kind] && { backgroundColor: colors.brassSoft },
                ]}
              >
                <Text style={text.body}>{label}</Text>
                {skip.settings?.[kind] && <Icon name="check" size={20} color={colors.brass} />}
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.panel}>
          <Text style={text.h2}>Themamuziek</Text>
          <Text style={text.muted}>
            Op de pagina van een serie speelt zacht de titelmuziek (van Plex). Op een telefoon staat
            dat uit tot je het kiest.
          </Text>
          {THEME_LEVELS.map((t) => (
            <Pressable
              key={t.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: themeLevel === t.id }}
              onPress={() => setThemeLevel(t.id)}
              style={[styles.option, themeLevel === t.id && { backgroundColor: colors.brassSoft }]}
            >
              <Text style={text.body}>{t.label}</Text>
              {themeLevel === t.id && <Icon name="check" size={20} color={colors.brass} />}
            </Pressable>
          ))}
        </View>

        <NotificationSettingsPanel />

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <Button
            label="Mijn lijst"
            kind="secondary"
            icon="plus"
            style={{ flex: 1, minWidth: 130 }}
            onPress={() => router.push('/my-list')}
          />
          <Button
            label="Collecties"
            kind="secondary"
            icon="film"
            style={{ flex: 1, minWidth: 130 }}
            onPress={() => router.push('/collections')}
          />
          <Button
            label="Agenda"
            kind="secondary"
            icon="calendar"
            style={{ flex: 1, minWidth: 130 }}
            onPress={() => router.push('/calendar')}
          />
          {/* A kids profile can't ask for titles. */}
          {!kids && (
            <Button
              label="Verzoeken"
              kind="secondary"
              icon="sparkle"
              style={{ flex: 1, minWidth: 130 }}
              onPress={() => router.push('/requests')}
            />
          )}
        </View>

        {!isCar && <LinkTv />}

        <ServerAddresses />

        <Button
          label="Ander profiel / uitloggen"
          kind="secondary"
          icon="logout"
          onPress={() => void signOut()}
        />
        <Text style={[text.small, { textAlign: 'center' }]}>
          CineVault {Constants.expoConfig?.version ?? ''} · Je naam, kleur en wachtwoord wijzig je
          in de webinterface.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: gutter, gap: 18, paddingBottom: 32 },
  // A column in the middle of a car's wide screen.
  carPage: { width: '100%', maxWidth: carLayout.column + 2 * gutter, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 8 },
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
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: radius.s,
  },
});

// The TV has its own screens, for the remote.
export default isTV ? TvProfile : ProfileScreen;
