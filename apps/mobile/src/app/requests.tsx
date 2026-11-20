import {
  type DownloadEntry,
  type MediaRequestDto,
  requestPartsLabel,
  type RequestStatus,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DownloadLine } from '../components/Download';
import { Button, errorText, IconButton, ServerImage, text } from '../components/ui';
import { TvPressable } from '../tv/focus';
import { STATUS_COLOR, STATUS_LABEL } from '../discover';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, gutter, radius } from '../theme';

function Status({ status }: { status: RequestStatus }) {
  return (
    <Text style={[styles.status, { color: STATUS_COLOR[status] }]}>{STATUS_LABEL[status]}</Text>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.requests }),
      queryClient.invalidateQueries({ queryKey: ['discover'] }),
    ]);
}

function Request({ request }: { request: MediaRequestDto }) {
  const { api, user } = useSession();
  const refresh = useRefresh();
  const admin = user?.role === 'ADMIN';
  const approve = useMutation({
    mutationFn: () => api.approveRequest(request.id),
    onSettled: refresh,
  });
  const decline = useMutation({
    mutationFn: () => api.declineRequest(request.id),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRequest(request.id),
    onSettled: refresh,
  });
  const mine = request.requestedBy.some((r) => r.id === user?.id);
  const open = request.status === 'PENDING' || request.status === 'FAILED';
  const failed = approve.error ?? decline.error ?? remove.error;
  return (
    <View style={styles.card}>
      <ServerImage path={request.posterUrl} style={styles.posterSmall} fallback={request.title} />
      <View style={styles.cardText}>
        <Text style={styles.title} numberOfLines={2}>
          {request.title}
          {request.year ? ` (${request.year})` : ''}
        </Text>
        {requestPartsLabel(request) ? (
          <Text style={[text.small, { color: colors.brass }]}>{requestPartsLabel(request)}</Text>
        ) : null}
        <Status status={request.status} />
        {request.download && <DownloadLine download={request.download} />}
        <Text style={text.small}>
          {request.kind === 'movie' ? 'Film' : request.anime ? 'Anime' : 'Serie'} · gevraagd door{' '}
          {request.requestedBy.map((r) => r.displayName).join(', ')}
        </Text>
        {request.reason ? (
          <Text style={[text.muted, { fontStyle: 'italic' }]}>{request.reason}</Text>
        ) : null}
        <View style={styles.actions}>
          {request.itemId && (
            <Button
              label="Bekijken"
              icon="play"
              kind="glass"
              onPress={() => router.push(`/item/${request.itemId}`)}
            />
          )}
          {admin && open && (
            <>
              <Button
                label={request.status === 'FAILED' ? 'Opnieuw' : 'Goedkeuren'}
                icon="check"
                disabled={approve.isPending}
                onPress={() => approve.mutate()}
              />
              {request.status === 'PENDING' && (
                <Button
                  label="Afwijzen"
                  icon="close"
                  kind="glass"
                  disabled={decline.isPending}
                  onPress={() => decline.mutate()}
                />
              )}
            </>
          )}
          {!admin && mine && request.status === 'PENDING' && (
            <Button label="Intrekken" kind="glass" onPress={() => remove.mutate()} />
          )}
        </View>
        {failed ? <Text style={styles.error}>{errorText(failed)}</Text> : null}
      </View>
    </View>
  );
}

/** A title in the queue of Radarr or Sonarr; opens it when it is in the library already. */
function Download({ entry }: { entry: DownloadEntry }) {
  const itemId = entry.itemId;
  return (
    <TvPressable
      accessibilityRole={itemId ? 'button' : undefined}
      disabled={!itemId}
      onPress={() => itemId && router.push(`/item/${itemId}`)}
      style={styles.card}
    >
      <ServerImage path={entry.posterUrl} style={styles.posterSmall} fallback={entry.title} />
      <View style={[styles.cardText, { justifyContent: 'center' }]}>
        <Text style={styles.title} numberOfLines={2}>
          {entry.title}
        </Text>
        <DownloadLine download={entry} />
      </View>
    </TvPressable>
  );
}

/** "Verzoeken": what is being downloaded, and what the household asked for; admins approve it here. */
function RequestsScreen() {
  const { api } = useSession();
  const requests = useQuery({
    queryKey: keys.requests,
    queryFn: api.requests,
    refetchInterval: (query) => (query.state.data?.some((r) => r.download) ? 15_000 : false),
  });
  // Radarr's and Sonarr's queue; empty (or 403 for a kids profile) shows nothing.
  const downloads = useQuery({
    queryKey: keys.downloads,
    queryFn: api.downloads,
    refetchInterval: 10_000,
  });
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.head}>
        <IconButton icon="back" label="Terug" onPress={() => router.back()} />
        <Text style={text.h1}>Verzoeken</Text>
      </View>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={text.muted}>
          Wat er is aangevraagd. Iets nieuws aanvragen doe je onder Ontdekken.
        </Text>
        <Button
          label="Naar Ontdekken"
          icon="compass"
          kind="secondary"
          onPress={() => router.push('/discover')}
        />
        {downloads.data && downloads.data.length > 0 && (
          <>
            <Text style={[text.h2, { marginTop: 6 }]}>Wordt gedownload</Text>
            {downloads.data.map((entry) => (
              <Download key={`${entry.kind}-${entry.tmdbId ?? entry.title}`} entry={entry} />
            ))}
            <Text style={[text.h2, { marginTop: 6 }]}>Aangevraagd</Text>
          </>
        )}
        {requests.data?.length === 0 && <Text style={text.muted}>Nog geen verzoeken.</Text>}
        {requests.data?.map((request) => (
          <Request key={request.id} request={request} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  page: { padding: gutter, gap: 12, paddingBottom: 40 },
  card: {
    flexDirection: 'row',
    gap: 12,
    padding: 10,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  posterSmall: { width: 60, height: 90, borderRadius: radius.s },
  cardText: { flex: 1, gap: 4 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  status: { fontWeight: '800', fontSize: 13 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  error: { fontSize: 14, color: '#f08a7a' },
});

// Also on the TV: its buttons take the remote's focus.
export default RequestsScreen;
