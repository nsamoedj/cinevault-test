// Logging in on the TV without typing: a QR code (and a short code) that a
// phone opens at /link; once someone confirms there, the TV is logged in as
// them. A new code comes by itself when one runs out.

import { type DeviceLoginStart } from '@cinevault/shared';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { errorText } from '../../components/ui';
import { useSession } from '../../session';
import { colors, radius } from '../../theme';
import { QrCode } from '../QrCode';
import { TV_GUTTER, TvButton, tvText } from '../ui';

function deviceName(): string {
  const constants = Platform.constants as { Brand?: string; Model?: string };
  const model = [constants.Brand, constants.Model].filter(Boolean).join(' ');
  return model ? `Android TV (${model})` : 'Android TV';
}

const pretty = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function TvLogin({ onPassword }: { onPassword: () => void }) {
  const { api, server, signedIn, setServer } = useSession();
  const [login, setLogin] = useState<DeviceLoginStart>();
  const [error, setError] = useState<string>();
  // A new code: at the start, and when the old one ran out.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(started: DeviceLoginStart) {
      if (stopped) return;
      try {
        const answer = await api.pollDeviceLogin(started.secret);
        if (stopped) return;
        if (answer.status === 'approved') {
          await signedIn(answer.token, answer.user);
          return;
        }
        if (answer.status === 'expired') {
          setRound((r) => r + 1);
          return;
        }
        setError(undefined);
      } catch (e) {
        // 410: the code ran out (or the server restarted); otherwise try again.
        if ((e as { status?: number }).status === 410) {
          setRound((r) => r + 1);
          return;
        }
        setError(errorText(e));
      }
      timer = setTimeout(() => void poll(started), started.interval * 1000);
    }
    void api
      .startDeviceLogin(deviceName())
      .then((started) => {
        if (stopped) return;
        setLogin(started);
        setError(undefined);
        timer = setTimeout(() => void poll(started), started.interval * 1000);
      })
      .catch((e: unknown) => {
        if (stopped) return;
        setError(errorText(e));
        timer = setTimeout(() => setRound((r) => r + 1), 5_000);
      });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, signedIn, round]);

  const base = (server ?? '').replace(/\/+$/, '');
  const link = login ? `${base}/link?code=${login.code}` : '';
  const shown = base.replace(/^https?:\/\//, '');

  return (
    <View style={styles.page}>
      <Text style={styles.brand}>
        Cine<Text style={{ color: colors.brass }}>Vault</Text>
      </Text>
      <View style={styles.row}>
        <View style={styles.qr}>
          {login ? (
            <QrCode value={link} size={236} />
          ) : (
            <ActivityIndicator color={colors.brass} size="large" />
          )}
        </View>
        <View style={styles.text}>
          <Text style={tvText.h1}>Inloggen met je telefoon</Text>
          <Text style={tvText.body}>1. Scan de QR-code met de camera van je telefoon.</Text>
          <Text style={tvText.body}>
            2. Of ga op je telefoon naar <Text style={styles.strong}>{shown}/link</Text> en typ de
            code:
          </Text>
          <Text style={styles.code} accessibilityLabel={login ? `Code ${login.code}` : undefined}>
            {login ? pretty(login.code) : '····-····'}
          </Text>
          <Text style={tvText.body}>
            3. Kies daar &quot;Inloggen als …&quot;. De tv volgt vanzelf.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.buttons}>
            <TvButton label="Inloggen met wachtwoord" icon="user" autoFocus onPress={onPassword} />
            <TvButton label="Ander serveradres" onPress={() => void setServer(undefined)} />
          </View>
          <Text style={tvText.small}>
            Op je telefoon moet je in CineVault ingelogd zijn (in de browser of in de app). De code
            werkt 10 minuten; daarna komt er vanzelf een nieuwe.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: TV_GUTTER + 20,
    paddingVertical: 28,
    justifyContent: 'center',
    gap: 22,
  },
  brand: { color: colors.text, fontSize: 28, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 44 },
  qr: {
    width: 260,
    height: 260,
    borderRadius: radius.l,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 10 },
  strong: { color: colors.brass, fontWeight: '800' },
  code: {
    color: colors.text,
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 6,
    marginVertical: 2,
  },
  error: { color: colors.danger, fontSize: 15 },
  buttons: { flexDirection: 'row', gap: 14, marginTop: 6 },
});
