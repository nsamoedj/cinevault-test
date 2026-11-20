import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createApiClient } from '@cinevault/shared';
import { Icon } from '../components/Icon';
import { addressLabel, orderAddresses } from '../components/ServerAddresses';
import { Button, errorText, Input, text } from '../components/ui';
import { normalizeServer, useSession } from '../session';
import { colors, radius } from '../theme';

/** First start: where the CineVault server is (its domain, at home, or over Tailscale). */
export default function ConnectScreen() {
  const { setServer } = useSession();
  const [input, setInput] = useState('');
  // A second address of the same server: home and on the road.
  const [second, setSecond] = useState('');
  const [both, setBoth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function connect() {
    const list = orderAddresses(
      [input, both ? second : '']
        .map((v) => v.trim())
        .filter(Boolean)
        .map(normalizeServer),
    );
    setBusy(true);
    setError(undefined);
    try {
      // At least one must answer here; the other may only work elsewhere
      // (the domain from home, the home address on the road).
      const answers = await Promise.all(
        list.map((server) =>
          createApiClient({ baseUrl: server })
            .health()
            .then((h) => h.status)
            .catch(() => undefined),
        ),
      );
      if (!answers.includes('ok')) {
        if (answers.includes('degraded'))
          throw new Error('De server antwoordt, maar de database is niet klaar.');
        throw new TypeError(`network: ${list.map(addressLabel).join(', ')}`);
      }
      await setServer(list);
    } catch (e) {
      setError(
        e instanceof TypeError || /network/i.test(String(e))
          ? 'Geen CineVault op dit adres. Klopt het adres? Thuis met de poort (8765), buitenshuis het domein of Tailscale.'
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>
            Cine<Text style={{ color: colors.brass }}>Vault</Text>
          </Text>
          <View style={styles.card}>
            <Icon name="server" size={36} color={colors.brass} />
            <Text style={text.h1}>Verbinden met je server</Text>
            <Text style={text.muted}>
              Het adres van CineVault, zoals in de browser: het domein (bijvoorbeeld cine-vault.nl),
              dat thuis en onderweg werkt, of thuis 192.168.0.110:8765.
            </Text>
            <Input
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="cine-vault.nl"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={() => void connect()}
              accessibilityLabel="Serveradres"
            />
            {both ? (
              <>
                <Text style={text.muted}>
                  Het andere adres van dezelfde server. Thuis gebruikt de app het lokale adres,
                  onderweg het domein, vanzelf.
                </Text>
                <Input
                  style={styles.input}
                  value={second}
                  onChangeText={setSecond}
                  placeholder="192.168.0.110:8765"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="go"
                  onSubmitEditing={() => void connect()}
                  accessibilityLabel="Tweede serveradres"
                />
              </>
            ) : (
              <Button
                label="Tweede adres (thuis en onderweg)"
                icon="plus"
                kind="secondary"
                onPress={() => setBoth(true)}
              />
            )}
            {error && <Text style={styles.error}>{error}</Text>}
            <Button
              label={busy ? 'Verbinden…' : 'Verbinden'}
              disabled={busy || !input.trim()}
              onPress={() => void connect()}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  page: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 28 },
  brand: { color: colors.text, fontSize: 30, fontWeight: '800', textAlign: 'center' },
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
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
});
