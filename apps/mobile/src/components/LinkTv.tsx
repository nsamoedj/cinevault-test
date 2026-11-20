// On the phone: logging a TV in with the code it shows ("Inloggen met je
// telefoon" on the TV), as the profile that is signed in here.

import { ApiError, type DeviceLoginInfo } from '@cinevault/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { Button, errorText, Input, text } from './ui';

const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

function problem(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'Deze code bestaat niet (meer). Kies op de tv opnieuw "Inloggen met je telefoon".';
  }
  if (error instanceof ApiError && error.status === 409) return 'Deze code is al gebruikt.';
  return errorText(error);
}

export function LinkTv() {
  const { api, user } = useSession();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<DeviceLoginInfo>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await step();
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.panel}>
      <Text style={text.h2}>Inloggen op een tv</Text>
      {done ? (
        <>
          <Text style={styles.ok}>Klaar. De tv is ingelogd als {user?.displayName}.</Text>
          <Button
            label="Nog een tv"
            kind="secondary"
            onPress={() => {
              setDone(false);
              setFound(undefined);
              setCode('');
            }}
          />
        </>
      ) : found ? (
        <>
          <Text style={text.body}>
            {found.deviceName} vraagt om in te loggen met code {found.code}.
          </Text>
          <Button
            label={busy ? 'Bezig…' : `Inloggen als ${user?.displayName ?? 'mij'}`}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await api.approveDeviceLogin(found.code);
                setDone(true);
              })
            }
          />
          <Button label="Andere code" kind="secondary" onPress={() => setFound(undefined)} />
        </>
      ) : (
        <>
          <Text style={text.muted}>
            Kies op de tv &quot;Inloggen met je telefoon&quot;. Scan de QR-code met je camera, of
            typ hier de code die de tv toont.
          </Text>
          <Input
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="BCDF-2345"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={12}
            accessibilityLabel="Code van de tv"
            onSubmitEditing={() =>
              void run(async () => setFound(await api.deviceLogin(normalize(code))))
            }
          />
          <Button
            label={busy ? 'Bezig…' : 'Verder'}
            disabled={busy || normalize(code).length !== 8}
            onPress={() => void run(async () => setFound(await api.deviceLogin(normalize(code))))}
          />
        </>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 10,
  },
  input: {
    minHeight: 50,
    borderRadius: radius.s,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 3,
  },
  ok: { color: colors.ok, fontSize: 16, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 14 },
});
