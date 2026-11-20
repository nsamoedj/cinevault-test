// Beheer on a phone or tablet, for admins: what the web's admin pages have.
// Scanning, the libraries and what is in them, how far the search for
// intros and the theme music are, and the way to the other admin screens.

import {
  codecLabel,
  countLabel,
  type HealthLevel,
  healthLevelLabel,
  introSearchLines,
  libraryLabel,
  timeAgoLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { adminStyles, AdminLink, AdminScreen, Panel, useAttention } from '../admin/ui';
import { Button, errorText, text } from '../components/ui';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors } from '../theme';

function Scan() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const scan = useQuery({
    queryKey: keys.scan,
    queryFn: api.scanStatus,
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : 15_000),
  });
  const start = useMutation({
    mutationFn: (refreshMetadata: boolean) => api.startScan({ refreshMetadata }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.scan }),
  });
  const data = scan.data;
  const running = data?.running ?? false;
  return (
    <Panel title="Bibliotheek scannen">
      <Text style={text.muted}>
        {running
          ? `Bezig${data?.libraryName ? ` met ${data.libraryName}` : ''}: ${data?.itemsMatched ?? 0} gematcht, ${data?.itemsUnmatched ?? 0} niet gematcht.`
          : 'Zoekt nieuwe en verdwenen bestanden en haalt de metadata op. Ongewijzigde bestanden worden overgeslagen.'}
      </Text>
      {data?.finishedAt && !running ? (
        <Text style={text.small}>
          Laatste scan: {new Date(data.finishedAt).toLocaleString('nl-NL')}
        </Text>
      ) : null}
      {data?.errors.slice(0, 5).map((error) => (
        <Text key={error} style={[text.small, adminStyles.error]}>
          {error}
        </Text>
      ))}
      <View style={adminStyles.row}>
        <Button
          label={running ? 'Scan bezig…' : 'Scannen'}
          icon="search"
          disabled={running || start.isPending}
          onPress={() => start.mutate(false)}
        />
        <Button
          label="Alles vernieuwen"
          kind="secondary"
          disabled={running || start.isPending}
          onPress={() => start.mutate(true)}
        />
      </View>
      {start.error ? (
        <Text style={adminStyles.error}>Scan niet gestart: {errorText(start.error)}</Text>
      ) : null}
    </Panel>
  );
}

function Libraries() {
  const { api } = useSession();
  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const all = libraries.data ?? [];
  if (libraries.error) return <Text style={adminStyles.error}>{errorText(libraries.error)}</Text>;
  if (all.length === 0) return null;
  return (
    <Panel title="Bibliotheken">
      {all.map((library) => (
        <View key={library.id} style={styles.libraryRow}>
          <View style={{ flex: 1 }}>
            <Text style={adminStyles.line}>{libraryLabel(library, all)}</Text>
            <Text style={text.small}>{library.name}</Text>
          </View>
          <Text style={text.muted}>{countLabel(library.itemCount, 'titel', 'titels')}</Text>
        </View>
      ))}
    </Panel>
  );
}

function CountList({
  title,
  counts,
  label = codecLabel,
}: {
  title: string;
  counts: Record<string, number>;
  label?: (key: string) => string;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.countTitle}>{title}</Text>
      {rows.map(([key, count]) => (
        <View key={key} style={styles.countRow}>
          <Text style={styles.countLabel} numberOfLines={1}>
            {label(key)}
          </Text>
          <View style={styles.countTrack}>
            <View style={[styles.countBar, { width: `${(count / Math.max(total, 1)) * 100}%` }]} />
          </View>
          <Text style={styles.countValue}>{count}</Text>
        </View>
      ))}
    </View>
  );
}

function LibraryStats() {
  const { api } = useSession();
  const { data } = useQuery({ queryKey: keys.codecStats, queryFn: api.codecStats });
  if (!data || data.files === 0) return null;
  return (
    <Panel title="Wat zit er in je bibliotheek">
      <Text style={text.muted}>
        {countLabel(data.files, 'bestand', 'bestanden')}. Wat een apparaat niet direct kan afspelen,
        zet de server om tijdens het kijken.
      </Text>
      <CountList title="Video" counts={data.videoCodecs} />
      <CountList title="Audio (standaardspoor)" counts={data.defaultAudioCodecs} />
      <CountList title="Resolutie" counts={data.resolutions} label={(k) => k} />
      <CountList title="HDR" counts={data.hdr} label={(k) => k} />
    </Panel>
  );
}

function IntroSearch() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: keys.introStatus,
    queryFn: api.introStatus,
    refetchInterval: (query) => (query.state.data?.rush ? 5_000 : 30_000),
  });
  const rush = useMutation({
    mutationFn: (on: boolean) => (on ? api.searchAllIntros() : api.stopSearchAllIntros()),
    onSuccess: (next) => queryClient.setQueryData(keys.introStatus, next),
  });
  if (!data || (data.episodes === 0 && !data.films)) return null;
  const done =
    data.checked >= data.episodes &&
    (data.creditsChecked ?? data.episodes) >= data.episodes &&
    (data.recapChecked ?? data.episodes) >= data.episodes &&
    (data.filmsChecked ?? 0) >= (data.films ?? 0);
  return (
    <Panel title="Intro, recap en aftiteling">
      <Text style={text.muted}>
        De server zoekt per aflevering de intro, de recap en de aftiteling: bij AniSkip (anime), in
        de hoofdstukken van het bestand, of in het geluid dat afleveringen delen. Bij films zoekt
        hij de aftiteling in het beeld; een scène na de aftiteling wordt nooit overgeslagen. Dat
        gebeurt als niemand kijkt; wat je opent, gaat voor.
      </Text>
      <Text style={adminStyles.line}>
        Intro: {data.checked} van {data.episodes} bekeken, gevonden in {data.found}.
      </Text>
      {data.creditsChecked !== undefined && (
        <Text style={adminStyles.line}>
          Aftiteling: {data.creditsChecked} van {data.episodes} bekeken, gevonden in{' '}
          {data.creditsFound ?? 0}.
        </Text>
      )}
      {data.recapChecked !== undefined && (
        <Text style={adminStyles.line}>
          Recap: {data.recapChecked} van {data.episodes} bekeken, gevonden in {data.recapFound ?? 0}
          .
        </Text>
      )}
      {data.previewChecked !== undefined && (
        <Text style={adminStyles.line}>
          Preview van de volgende aflevering: {data.previewChecked} van {data.episodes} bekeken,
          gevonden in {data.previewFound ?? 0}.
        </Text>
      )}
      {(data.uncertain ?? 0) > 0 && (
        <Text style={text.small}>
          {data.uncertain === 1 ? '1 deel is' : `${data.uncertain} delen zijn`} te onzeker voor de
          spelers. Bekijk ze per seizoen: pagina van de serie → Beheer → Intro, recap en aftiteling
          per aflevering.
        </Text>
      )}
      {data.films !== undefined && data.films > 0 && (
        <Text style={adminStyles.line}>
          Aftiteling van films: {data.filmsChecked ?? 0} van {data.films} bekeken, gevonden in{' '}
          {data.filmsFound ?? 0}.
        </Text>
      )}
      {!done && !data.rush && data.waiting === 'playback' && (
        <Text style={text.small}>Wacht tot niemand meer kijkt.</Text>
      )}
      {!done && data.waiting === 'transcoder' && (
        <Text style={text.small}>Wacht op de transcoder.</Text>
      )}
      {introSearchLines(data).map((line) => (
        <Text key={line} style={text.small} numberOfLines={3}>
          {line}
        </Text>
      ))}
      {data.rush || !done ? (
        <Button
          label={data.rush ? 'Stoppen' : 'Nu alles zoeken'}
          kind="secondary"
          disabled={rush.isPending}
          onPress={() => rush.mutate(!data.rush)}
        />
      ) : null}
      {data.rush ? (
        <Text style={text.small}>
          De server zoekt nu alle afleveringen achter elkaar, ook als er gekeken wordt. Kijken kan
          daardoor haperen. Stoppen gaat terug naar zoeken als niemand kijkt.
        </Text>
      ) : null}
      {rush.error ? <Text style={adminStyles.error}>{errorText(rush.error)}</Text> : null}
      <Text style={text.small}>
        Klopt een intro, recap of aftiteling niet? Pas die aan in de speler, onder Instellingen.
      </Text>
    </Panel>
  );
}

function ThemeMusicStatus() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: keys.themeStatus,
    queryFn: api.themeStatus,
    refetchInterval: 30_000,
  });
  const retry = useMutation({
    mutationFn: api.retryThemes,
    onSuccess: (status) => {
      queryClient.setQueryData(keys.themeStatus, status);
      // The server asks Plex in the background, a second per show.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.themeStatus }), 15_000);
    },
  });
  if (!data) return null;
  const missing = data.missing ?? [];
  const waiting = data.shows - data.ready - data.none - data.failed;
  return (
    <Panel title="Themamuziek">
      {!data.enabled ? (
        <Text style={text.muted}>Uitgezet (PLEX_THEMES=false).</Text>
      ) : (
        <>
          <Text style={text.muted}>
            De titelmuziek van series komt van de themadienst van Plex; heeft Plex niets, dan bij
            anime de eerste opening van AnimeThemes, en anders het nummer dat ThemerrDB op YouTube
            aanwijst. Elk nummer wordt één keer opgehaald. Elke 10 minuten haalt de server er een
            aantal op.
          </Text>
          <Text style={adminStyles.line}>
            {data.ready} van {countLabel(data.shows, 'serie', 'series')} hebben themamuziek.
            {data.none > 0 ? ` Geen bron heeft er een voor ${data.none}.` : ''}
            {data.failed > 0 ? ` Bij ${data.failed} ging het ophalen mis.` : ''}
            {waiting > 0 ? ` Nog te doen: ${waiting}.` : ''}
          </Text>
          {data.pausedUntil ? (
            <Text style={[text.small, adminStyles.error]}>
              {data.pausedSource === 'animethemes'
                ? 'AnimeThemes'
                : data.pausedSource === 'themerrdb'
                  ? 'YouTube (ThemerrDB)'
                  : 'Plex'}{' '}
              is niet bereikbaar; de server probeert het opnieuw om{' '}
              {new Date(data.pausedUntil).toLocaleTimeString('nl-NL', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </Text>
          ) : null}
          {data.lastError ? (
            <Text style={text.small}>
              Laatste fout ({new Date(data.lastError.at).toLocaleString('nl-NL')}):{' '}
              {data.lastError.message}
            </Text>
          ) : null}
          {missing.length > 0 ? (
            <Button
              label={`${open ? 'Verberg' : 'Toon'} de series zonder themamuziek (${missing.length})`}
              kind="secondary"
              onPress={() => setOpen((o) => !o)}
            />
          ) : null}
          {open && missing.length > 0 ? (
            <>
              <Text style={text.small}>
                Wat elke bron antwoordde. Plex zoekt op het TVDB-nummer (404: geen theme voor dat
                nummer), AnimeThemes alleen voor anime (geen opening, of niet bij AnimeThemes),
                ThemerrDB op het TMDB-nummer (niet in ThemerrDB, of een YouTube-video die er niet
                meer is). Klopt het nummer niet (een verkeerde match), corrigeer dan de match.
              </Text>
              {missing.map((show) => (
                <Pressable
                  key={show.itemId}
                  accessibilityRole="link"
                  onPress={() => router.push(`/item/${show.itemId}`)}
                  style={styles.missingRow}
                >
                  <Text style={styles.missingTitle} numberOfLines={1}>
                    {show.title}
                    {show.year ? ` (${show.year})` : ''}
                  </Text>
                  <Text style={[text.small, !show.none && adminStyles.error]}>
                    {show.tvdbId ? `TVDB ${show.tvdbId} · ` : ''}
                    {show.reason}
                  </Text>
                </Pressable>
              ))}
            </>
          ) : null}
          <Button
            label="Nu opnieuw proberen"
            kind="secondary"
            disabled={retry.isPending}
            onPress={() => retry.mutate()}
          />
          {retry.error ? <Text style={adminStyles.error}>{errorText(retry.error)}</Text> : null}
        </>
      )}
    </Panel>
  );
}

const LEVEL_COLOR: Record<HealthLevel, string> = {
  ok: colors.ok,
  warning: colors.brass,
  error: colors.danger,
  unknown: colors.text3,
};

/** Disks, back-ups, the transcoder, scans, the certificate, Radarr and Sonarr. */
function Health() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: keys.health,
    queryFn: () => api.serverHealth(),
    refetchInterval: 60_000,
  });
  const again = useMutation({
    mutationFn: () => api.serverHealth(true),
    onSuccess: (report) => queryClient.setQueryData(keys.health, report),
  });
  if (error) return <Text style={adminStyles.error}>{errorText(error)}</Text>;
  if (!data) return null;
  return (
    <Panel title={`Gezondheid · ${healthLevelLabel[data.level]}`}>
      {data.checks.map((check) => (
        <View key={check.id} style={styles.healthRow}>
          <View style={[styles.healthDot, { backgroundColor: LEVEL_COLOR[check.level] }]} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={adminStyles.line}>{check.label}</Text>
            <Text style={text.small}>{check.detail}</Text>
            {check.level !== 'ok' && check.hint ? (
              <Text style={[text.small, { color: colors.text3 }]}>{check.hint}</Text>
            ) : null}
            {check.since ? (
              <Text style={[text.small, { color: colors.text3 }]}>
                Sinds {timeAgoLabel(check.since).toLowerCase()}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
      <Text style={text.small}>
        Bekeken {timeAgoLabel(data.checkedAt).toLowerCase()}. Gaat er iets mis, dan krijgen
        beheerders een melding.
      </Text>
      <Button
        label="Opnieuw kijken"
        kind="secondary"
        disabled={again.isPending}
        onPress={() => again.mutate()}
      />
    </Panel>
  );
}

function AdminHome() {
  const attention = useAttention();
  return (
    <AdminScreen title="Overzicht">
      <Health />
      <AdminLink
        icon="alert"
        title="Aandacht nodig"
        sub={
          attention.pending
            ? 'Titels zonder match'
            : attention.rows.length === 0
              ? 'Alles is gematcht'
              : 'Titels zonder match: zelf de goede kiezen'
        }
        badge={attention.rows.length}
        onPress={() => router.push('/attention')}
      />
      <AdminLink
        icon="user"
        title="Accounts"
        sub="Profielen toevoegen, wijzigen en verwijderen"
        onPress={() => router.push('/accounts')}
      />
      <AdminLink
        icon="server"
        title="Verzoeken"
        sub="Goedkeuren, en waar Radarr en Sonarr nieuwe titels zetten"
        onPress={() => router.push('/request-settings')}
      />
      <Scan />
      <Libraries />
      <LibraryStats />
      <IntroSearch />
      <ThemeMusicStatus />
    </AdminScreen>
  );
}

const styles = StyleSheet.create({
  libraryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40 },
  countTitle: { color: colors.text2, fontSize: 13, fontWeight: '800', marginTop: 4 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  countLabel: { color: colors.text, fontSize: 14, width: 110 },
  countTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.glass },
  countBar: { height: 6, borderRadius: 3, backgroundColor: colors.brass },
  countValue: { color: colors.text2, fontSize: 13, width: 44, textAlign: 'right' },
  healthRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  healthDot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  missingRow: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.line },
  missingTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
});

export default AdminHome;
