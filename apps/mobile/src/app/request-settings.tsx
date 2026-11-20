// Beheer → Verzoeken, for admins: approving the household's requests, and
// where Radarr and Sonarr put new titles (folder and quality), as on the web.

import type { ArrServerInfo, ArrTarget, RequestsConfig } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { adminStyles, AdminScreen, Panel } from '../admin/ui';
import { Icon } from '../components/Icon';
import { Button, errorText, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';

function Connection({ name, info, envKey }: { name: string; info: ArrServerInfo; envKey: string }) {
  if (!info.configured) {
    return (
      <Text style={text.muted}>
        {name} is niet gekoppeld. Zet {envKey} in .env op de server (de API-key staat in {name}{' '}
        onder Settings → General) en start opnieuw met scripts/up.sh.
      </Text>
    );
  }
  if (!info.ok) return <Text style={adminStyles.error}>{info.error}</Text>;
  return (
    <Text style={text.muted}>Verbonden{info.version ? ` met ${name} ${info.version}` : ''}.</Text>
  );
}

function Choice({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={[styles.option, on && { backgroundColor: colors.brassSoft }]}
    >
      <Text style={[text.body, { flex: 1 }]}>{label}</Text>
      {on && <Icon name="check" size={20} color={colors.brass} />}
    </Pressable>
  );
}

function TargetFields({
  label,
  info,
  value,
  onChange,
}: {
  label: string;
  info: ArrServerInfo;
  value: ArrTarget | undefined;
  onChange: (target: ArrTarget) => void;
}) {
  if (!info.ok) return null;
  const folder = value?.rootFolderPath ?? info.rootFolders[0]?.path ?? '';
  const profile = value?.qualityProfileId ?? info.qualityProfiles[0]?.id ?? 0;
  return (
    <View style={styles.target}>
      <Text style={styles.legend}>{label}</Text>
      <Text style={styles.field}>Map</Text>
      {info.rootFolders.map((f) => (
        <Choice
          key={f.path}
          label={`${f.path}${f.freeSpace ? ` (${Math.round(f.freeSpace / 1e9)} GB vrij)` : ''}`}
          on={f.path === folder}
          onPress={() => onChange({ rootFolderPath: f.path, qualityProfileId: profile })}
        />
      ))}
      <Text style={styles.field}>Kwaliteit</Text>
      {info.qualityProfiles.map((p) => (
        <Choice
          key={p.id}
          label={p.name}
          on={p.id === profile}
          onPress={() => onChange({ rootFolderPath: folder, qualityProfileId: p.id })}
        />
      ))}
    </View>
  );
}

function RequestSettingsScreen() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: keys.requestsConfig, queryFn: api.requestsConfig });
  const save = useMutation({
    mutationFn: (changes: Parameters<typeof api.setRequestsConfig>[0]) =>
      api.setRequestsConfig(changes),
    onSuccess: (saved: RequestsConfig) => queryClient.setQueryData(keys.requestsConfig, saved),
  });
  const data = config.data;
  return (
    <AdminScreen title="Verzoeken">
      <Button
        label="Naar de verzoeken"
        icon="chevronRight"
        kind="secondary"
        onPress={() => router.push('/requests')}
      />
      {config.isPending && <ActivityIndicator color={colors.brass} style={{ marginTop: 24 }} />}
      {config.error ? <Text style={adminStyles.error}>{errorText(config.error)}</Text> : null}
      {save.error ? (
        <Text style={adminStyles.error}>Opslaan lukte niet: {errorText(save.error)}</Text>
      ) : null}
      {data && (
        <>
          <Panel title="Goedkeuren">
            <View style={styles.switchRow}>
              <Text style={[text.body, { flex: 1 }]}>
                Verzoeken van leden meteen naar Radarr en Sonarr sturen, zonder goedkeuring
              </Text>
              <Switch
                value={data.autoApprove}
                onValueChange={(autoApprove) => save.mutate({ autoApprove })}
                trackColor={{ true: colors.brass, false: colors.surface3 }}
                thumbColor={colors.text}
              />
            </View>
            <Text style={text.small}>Verzoeken van beheerders gaan altijd meteen.</Text>
          </Panel>
          <Panel title="Radarr (films)">
            <Connection name="Radarr" info={data.radarr} envKey="RADARR_API_KEY" />
            <TargetFields
              label="Nieuwe films"
              info={data.radarr}
              value={data.movies}
              onChange={(movies) => save.mutate({ movies })}
            />
          </Panel>
          <Panel title="Sonarr (series en anime)">
            <Connection name="Sonarr" info={data.sonarr} envKey="SONARR_API_KEY" />
            <TargetFields
              label="Nieuwe series"
              info={data.sonarr}
              value={data.shows}
              onChange={(shows) => save.mutate({ shows })}
            />
            <TargetFields
              label="Nieuwe anime"
              info={data.sonarr}
              value={data.anime}
              onChange={(anime) => save.mutate({ anime })}
            />
          </Panel>
        </>
      )}
    </AdminScreen>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  target: { gap: 4, marginTop: 6 },
  legend: { color: colors.text, fontSize: 16, fontWeight: '800' },
  field: { color: colors.text2, fontSize: 13, fontWeight: '700', marginTop: 6 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: radius.s,
  },
});

export default RequestSettingsScreen;
