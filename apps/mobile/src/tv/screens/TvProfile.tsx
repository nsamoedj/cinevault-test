// The profile on the TV: who is watching, the quality for this TV, theme
// music, the server and signing out.

import { ageLabel, QUALITIES, type Quality } from '@cinevault/shared';
import Constants from 'expo-constants';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { NotificationList } from '../../components/Notifications';
import { Avatar } from '../../components/ui';
import { addressLabel, isHomeAddress } from '../../components/ServerAddresses';
import { type ThemeLevel, useQualitySetting, useThemeMusicSetting } from '../../preferences';
import { useProfileSkipSettings } from '../../player/skip';
import { useSession } from '../../session';
import { colors, radius } from '../../theme';
import { FocusMemory } from '../focus';
import { TV_GUTTER, TvButton, TvChip, tvText } from '../ui';

const THEME_LEVELS: { id: ThemeLevel; label: string }[] = [
  { id: 'off', label: 'Uit' },
  { id: 'soft', label: 'Zacht' },
  { id: 'normal', label: 'Normaal' },
  { id: 'loud', label: 'Luider' },
];

const QUALITY_LABEL: Record<Quality, string> = {
  original: 'Origineel',
  '1080p': '1080p (8 Mbit/s)',
  '720p': '720p (4 Mbit/s)',
};

/** "Automatisch overslaan" as chips: short labels for the TV. */
const SKIP_CHIPS = [
  { kind: 'intro', label: 'Intro' },
  { kind: 'recap', label: 'Recap' },
  { kind: 'credits', label: 'Aftiteling' },
  { kind: 'preview', label: 'Preview' },
] as const;

export function TvProfile() {
  const { user, server, servers, signOut, setServer } = useSession();
  const [quality, setQuality] = useQualitySetting();
  const [themeLevel, setThemeLevel] = useThemeMusicSetting();
  const skip = useProfileSkipSettings();

  return (
    <FocusMemory>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={styles.page}
      >
        {user && (
          <View style={styles.header}>
            <Avatar name={user.displayName} color={user.avatarColor} size={80} />
            <View>
              <Text style={tvText.h1}>{user.displayName}</Text>
              <Text style={tvText.muted}>
                {user.username} ·{' '}
                {user.role === 'ADMIN'
                  ? 'Beheerder'
                  : user.maxAge !== undefined
                    ? `Kinderprofiel · t/m ${ageLabel(user.maxAge)}`
                    : 'Lid'}
              </Text>
            </View>
          </View>
        )}

        <View style={styles.panel}>
          <Text style={tvText.h2}>Kwaliteit op deze tv</Text>
          <Text style={tvText.muted}>
            Origineel speelt het bestand zoals het is, als deze tv dat kan. Kies een lagere
            kwaliteit als het hapert; dan zet de server de video om.
          </Text>
          <View style={styles.row}>
            {QUALITIES.map((q, index) => (
              <TvChip
                key={q.id}
                label={QUALITY_LABEL[q.id]}
                on={quality === q.id}
                autoFocus={index === 0}
                onPress={() => setQuality(q.id)}
              />
            ))}
          </View>
        </View>

        {skip.settings && (
          <View style={styles.panel}>
            <Text style={tvText.h2}>Automatisch overslaan</Text>
            <Text style={tvText.muted}>Voor dit profiel, in elke speler.</Text>
            <View style={styles.row}>
              {SKIP_CHIPS.map(({ kind, label }) => (
                <TvChip
                  key={kind}
                  label={label}
                  on={skip.settings?.[kind] ?? false}
                  onPress={() => skip.toggle(kind)}
                />
              ))}
            </View>
          </View>
        )}

        <View style={styles.panel}>
          <Text style={tvText.h2}>Themamuziek</Text>
          <Text style={tvText.muted}>
            Op de pagina van een serie speelt zacht de titelmuziek (van Plex).
          </Text>
          <View style={styles.row}>
            {THEME_LEVELS.map((t) => (
              <TvChip
                key={t.id}
                label={t.label}
                on={themeLevel === t.id}
                onPress={() => setThemeLevel(t.id)}
              />
            ))}
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={tvText.h2}>Meldingen</Text>
          <Text style={tvText.muted}>
            Welke meldingen je krijgt, kies je in de app op je telefoon of in de browser.
          </Text>
          <NotificationList limit={10} />
        </View>

        <View style={styles.panel}>
          <Text style={tvText.h2}>Server</Text>
          {servers.length > 1 ? (
            <Text style={tvText.muted}>
              {servers
                .map(
                  (address) =>
                    `${isHomeAddress(address) ? 'Thuis' : 'Onderweg'}: ${addressLabel(address)}${address === server ? ' (in gebruik)' : ''}`,
                )
                .join('   ·   ')}
            </Text>
          ) : (
            <Text style={tvText.muted}>{addressLabel(server)}</Text>
          )}
          <View style={styles.row}>
            <TvButton
              label="Ander serveradres"
              icon="server"
              onPress={() => void setServer(undefined)}
            />
            <TvButton
              label="Ander profiel / uitloggen"
              icon="logout"
              onPress={() => void signOut()}
            />
          </View>
        </View>

        <Text style={tvText.small}>
          CineVault {Constants.expoConfig?.version ?? ''} · Je naam, kleur en wachtwoord wijzig je
          in de webinterface.
        </Text>
      </ScrollView>
    </FocusMemory>
  );
}

const styles = StyleSheet.create({
  page: { padding: TV_GUTTER, paddingTop: 32, gap: 22, maxWidth: 900 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.l,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 22,
    gap: 12,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingVertical: 4 },
});
