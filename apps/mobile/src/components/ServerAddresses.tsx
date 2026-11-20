// Profiel → Server: the server's address at home and on the road. The app uses
// whichever answers (home first); this shows which one it uses now, and lets
// the addresses be changed without logging out.

import { ApiError, createApiClient } from '@cinevault/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { normalizeServer } from '../server';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { Icon } from './Icon';
import { Button, Input, text } from './ui';

/** Plain for reading: without "http://". */
export function addressLabel(server: string | undefined): string {
  return (server ?? '').replace(/^https?:\/\//i, '');
}

/** An address is "home" when it is plain HTTP (an IP address, a port, a local name). */
export function isHomeAddress(server: string): boolean {
  return /^http:\/\//i.test(server);
}

/** Home first, then the domain: the order the app tries them. */
export function orderAddresses(list: string[]): string[] {
  const unique = [...new Set(list)];
  return [...unique.filter(isHomeAddress), ...unique.filter((s) => !isHomeAddress(s))];
}

const CHECK_TIMEOUT_MS = 6000;

/** ok: the same server and login; away: no answer; refused / other: see `problem`. */
type Check =
  | { kind: 'ok'; commit?: string }
  | { kind: 'away' }
  | { kind: 'refused'; status: number; commit?: string }
  | { kind: 'other'; commit?: string };

/** Answers it, and is it this server (the login works there too)? */
async function check(
  address: string,
  token: string | undefined,
  userId: string | undefined,
): Promise<Check> {
  const api = createApiClient({
    baseUrl: address,
    token: () => token,
    // An address that doesn't answer (another network) counts as away, not as busy forever.
    fetch: (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      return fetch(input, { ...init, signal: controller.signal }).finally(() =>
        clearTimeout(timer),
      );
    },
  });
  let commit: string | undefined;
  try {
    commit = (await api.health()).commit;
  } catch {
    return { kind: 'away' };
  }
  try {
    const me = await api.me();
    return me.id === userId ? { kind: 'ok', commit } : { kind: 'other', commit };
  } catch (error) {
    return error instanceof ApiError
      ? { kind: 'refused', status: error.status, commit }
      : { kind: 'away' };
  }
}

/** Why an address can't be added, in words, with what helps tell them apart. */
function problem(address: string, result: Check, results: Check[]): string | undefined {
  const label = addressLabel(address);
  const commits = [
    ...new Set(results.flatMap((r) => ('commit' in r && r.commit ? [r.commit.slice(0, 7)] : []))),
  ];
  const versions =
    commits.length > 1 ? ` De adressen geven een andere versie (${commits.join(' en ')}).` : '';
  if (result.kind === 'other') {
    return `Op ${label} staat een andere CineVault: daar ben je iemand anders.${versions} Kies daarvoor "Ander serveradres".`;
  }
  if (result.kind === 'refused') {
    return result.status === 401
      ? `${label} antwoordt, maar je login werkt daar niet (HTTP 401).${versions} Is dat dezelfde server als het andere adres?`
      : `${label} antwoordt met een fout (HTTP ${result.status}).${versions}`;
  }
  return undefined;
}

export function ServerAddresses() {
  const { server, servers, token, user, setAddresses, setServer } = useSession();
  const home = servers.find(isHomeAddress);
  const away = servers.find((s) => !isHomeAddress(s));
  const [editing, setEditing] = useState(false);
  const [homeInput, setHomeInput] = useState(addressLabel(home));
  const [awayInput, setAwayInput] = useState(addressLabel(away));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();

  async function save() {
    setBusy(true);
    setMessage(undefined);
    const list = orderAddresses(
      [homeInput, awayInput]
        .map((v) => v.trim())
        .filter(Boolean)
        .map(normalizeServer),
    );
    if (list.length === 0) {
      setBusy(false);
      setMessage({ error: true, text: 'Vul minstens één adres in.' });
      return;
    }
    const results = await Promise.all(list.map((a) => check(a, token, user?.id)));
    setBusy(false);
    const wrong = list
      .map((a, i) => problem(a, results[i] as Check, results))
      .find((text) => text !== undefined);
    if (wrong) {
      setMessage({ error: true, text: wrong });
      return;
    }
    if (!results.some((r) => r.kind === 'ok')) {
      setMessage({ error: true, text: 'Geen van de adressen antwoordt nu. Klopt het adres?' });
      return;
    }
    await setAddresses(list);
    setEditing(false);
    const silent = list.filter((_, i) => results[i]?.kind === 'away');
    setMessage({
      error: false,
      text:
        silent.length > 0
          ? `Opgeslagen. ${silent.map(addressLabel).join(' en ')} antwoordt hier nu niet; de app gebruikt het zodra het wel werkt (bijvoorbeeld buitenshuis).`
          : 'Opgeslagen.',
    });
  }

  const row = (label: string, address: string | undefined) =>
    address ? (
      <View style={styles.row}>
        <Icon
          name={isHomeAddress(address) ? 'home' : 'server'}
          size={20}
          color={address === server ? colors.brass : colors.text3}
        />
        <View style={{ flex: 1 }}>
          <Text style={text.small}>{label}</Text>
          <Text style={text.body} numberOfLines={1}>
            {addressLabel(address)}
          </Text>
        </View>
        {address === server && <Text style={styles.inUse}>In gebruik</Text>}
      </View>
    ) : null;

  return (
    <View style={styles.panel}>
      <Text style={text.h2}>Server</Text>
      {!editing && (
        <>
          {row('Thuis', home)}
          {row('Onderweg', away)}
          <Text style={text.muted}>
            {home && away
              ? 'De app gebruikt thuis het snelle lokale adres en onderweg het domein, vanzelf.'
              : 'Vul ook het andere adres in, dan kiest de app vanzelf: thuis het lokale adres, onderweg het domein.'}
          </Text>
        </>
      )}
      {editing && (
        <>
          <Text style={styles.label}>Thuis</Text>
          <Input
            style={styles.input}
            value={homeInput}
            onChangeText={setHomeInput}
            placeholder="192.168.0.110:8765"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Adres thuis"
          />
          <Text style={styles.label}>Onderweg</Text>
          <Input
            style={styles.input}
            value={awayInput}
            onChangeText={setAwayInput}
            placeholder="cine-vault.nl"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Adres onderweg"
          />
        </>
      )}
      {message && (
        <Text style={[text.small, { color: message.error ? colors.danger : colors.ok }]}>
          {message.text}
        </Text>
      )}
      {editing ? (
        <View style={styles.buttons}>
          <Button
            label="Annuleren"
            kind="secondary"
            style={{ flex: 1 }}
            onPress={() => {
              setEditing(false);
              setMessage(undefined);
            }}
          />
          <Button
            label={busy ? 'Controleren…' : 'Opslaan'}
            style={{ flex: 1 }}
            disabled={busy}
            onPress={() => void save()}
          />
        </View>
      ) : (
        <View style={styles.buttons}>
          <Button
            label="Adressen wijzigen"
            kind="secondary"
            icon="settings"
            style={{ flex: 1 }}
            onPress={() => {
              setHomeInput(addressLabel(home));
              setAwayInput(addressLabel(away));
              setMessage(undefined);
              setEditing(true);
            }}
          />
          <Button
            label="Andere server"
            kind="secondary"
            icon="server"
            style={{ flex: 1 }}
            accessibilityLabel="Ander serveradres"
            onPress={() => void setServer(undefined)}
          />
        </View>
      )}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  inUse: {
    color: colors.brass,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.brassSoft,
    overflow: 'hidden',
  },
  label: { color: colors.text, fontSize: 14, fontWeight: '700' },
  input: {
    minHeight: 48,
    borderRadius: radius.s,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  buttons: { flexDirection: 'row', gap: 10 },
});
