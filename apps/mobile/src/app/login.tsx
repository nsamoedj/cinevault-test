import { ApiError } from '@cinevault/shared';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../components/Icon';
import { Avatar, Button, errorText, Input, text } from '../components/ui';
import { type KnownProfile, useSession } from '../session';
import { isCar } from '../car';
import { colors, radius } from '../theme';
import { isTV, TvPressable } from '../tv/focus';
import { TvLogin } from '../tv/screens/TvLogin';

/** The API's English messages, in Dutch. */
function loginError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Verkeerde naam of wachtwoord.';
    if (error.status === 429) {
      const seconds = /(\d+) s/.exec(error.message)?.[1];
      return `Te veel pogingen. Probeer het ${seconds ? `over ${seconds} seconden` : 'zo'} opnieuw.`;
    }
  }
  return errorText(error);
}

/** "Wie kijkt er?": the profiles that signed in on this phone, then the password. */
function LoginScreen({ onPhone }: { onPhone?: () => void }) {
  const { api, server, profiles, signedIn, setServer, forgetProfile } = useSession();
  const [chosen, setChosen] = useState<KnownProfile | 'other' | undefined>(
    profiles.length === 0 ? 'other' : undefined,
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      const name = chosen && chosen !== 'other' ? chosen.username : username.trim();
      const { user, token } = await api.login(name, password);
      await signedIn(token, user);
    } catch (e) {
      setError(loginError(e));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const brand = (
    <Text style={styles.brand}>
      Cine<Text style={{ color: colors.brass }}>Vault</Text>
    </Text>
  );

  if (!chosen) {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.page}>
          {brand}
          <Text style={[text.h1, { textAlign: 'center' }]}>Wie kijkt er?</Text>
          <View style={styles.tiles}>
            {profiles.map((profile, index) => (
              <TvPressable
                key={profile.username}
                autoFocus={index === 0}
                accessibilityRole="button"
                accessibilityLabel={profile.displayName}
                accessibilityHint="Lang ingedrukt houden om te vergeten"
                onPress={() => setChosen(profile)}
                onLongPress={() => void forgetProfile(profile.username)}
                style={({ pressed }) => [styles.tile, pressed && { transform: [{ scale: 0.96 }] }]}
                focusStyle={styles.tileFocused}
              >
                <Avatar name={profile.displayName} color={profile.avatarColor} size={96} />
                <Text style={styles.tileName}>{profile.displayName}</Text>
              </TvPressable>
            ))}
            <TvPressable
              accessibilityRole="button"
              accessibilityLabel="Iemand anders"
              onPress={() => setChosen('other')}
              style={styles.tile}
              focusStyle={styles.tileFocused}
            >
              <View style={styles.addTile}>
                <Icon name="plus" size={36} color={colors.text3} />
              </View>
              <Text style={styles.tileName}>Iemand anders</Text>
            </TvPressable>
          </View>
          <Text style={[text.small, { textAlign: 'center' }]}>
            Lang indrukken om een profiel op deze telefoon te vergeten.
          </Text>
          {onPhone && (
            <Button label="Inloggen met je telefoon" kind="secondary" onPress={onPhone} />
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {brand}
          <View style={styles.card}>
            {chosen === 'other' ? (
              <>
                <Text style={[text.h1, { textAlign: 'center' }]}>Inloggen</Text>
                <Input
                  style={styles.input}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Gebruikersnaam"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="username"
                  accessibilityLabel="Gebruikersnaam"
                />
              </>
            ) : (
              <View style={{ alignItems: 'center', gap: 10 }}>
                <Avatar name={chosen.displayName} color={chosen.avatarColor} size={80} />
                <Text style={text.h1}>{chosen.displayName}</Text>
              </View>
            )}
            <Input
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Wachtwoord"
              secureTextEntry
              autoComplete="current-password"
              autoFocus={chosen !== 'other'}
              returnKeyType="go"
              onSubmitEditing={() => void login()}
              accessibilityLabel="Wachtwoord"
            />
            {error && <Text style={styles.error}>{error}</Text>}
            <Button
              label={busy ? 'Bezig…' : 'Inloggen'}
              disabled={busy || !password || (chosen === 'other' && !username.trim())}
              onPress={() => void login()}
            />
            {profiles.length > 0 && (
              <Button label="Ander profiel" kind="secondary" onPress={() => setChosen(undefined)} />
            )}
            {onPhone && (
              <Button label="Inloggen met je telefoon" kind="secondary" onPress={onPhone} />
            )}
          </View>
          <TvPressable
            accessibilityRole="button"
            onPress={() => void setServer(undefined)}
            style={styles.link}
            focusStyle={styles.linkFocused}
          >
            <Text style={[text.small, { textAlign: 'center' }]}>
              Server: {server?.replace(/^https?:\/\//, '')} · Ander adres
            </Text>
          </TvPressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  page: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 24 },
  brand: { color: colors.text, fontSize: 30, fontWeight: '800', textAlign: 'center' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 22 },
  tile: {
    alignItems: 'center',
    gap: 10,
    width: 120,
    padding: 6,
    borderRadius: radius.m,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  tileFocused: {
    borderColor: colors.brass,
    backgroundColor: colors.brassSoft,
    transform: [{ scale: 1.08 }],
  },
  link: {
    alignSelf: 'center',
    padding: 8,
    borderRadius: radius.s,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  linkFocused: { borderColor: colors.brass },
  tileName: { color: colors.text2, fontSize: 16, fontWeight: '600' },
  addTile: {
    width: 96,
    height: 96,
    borderRadius: 17,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.l,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 22,
    gap: 14,
  },
  input: {
    minHeight: 50,
    borderRadius: radius.s,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 17,
  },
  error: { color: colors.danger, fontSize: 14 },
});

/** The TV starts with the QR code (no typing with the remote); the password is one press away. */
function TvLoginScreen() {
  const [password, setPassword] = useState(false);
  return password ? (
    <LoginScreen onPhone={() => setPassword(false)} />
  ) : (
    <TvLogin onPassword={() => setPassword(true)} />
  );
}

function PhoneLoginScreen() {
  return <LoginScreen />;
}

// A car starts with the QR code too: a phone is quicker than the car's keyboard.
export default isTV || isCar ? TvLoginScreen : PhoneLoginScreen;
