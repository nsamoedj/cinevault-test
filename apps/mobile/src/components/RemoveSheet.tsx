// Removing a film, a show, a season or an episode (admins): what Radarr or
// Sonarr will delete from the disk, and a clear choice. CineVault scans the
// library afterwards, and then it is gone here too.

import { ApiError, type RemoveTarget, sizeLabel } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { Icon } from './Icon';
import { Button, errorText, text } from './ui';

/** After this, the scan (15 s after the request, then the scan itself) has usually run. */
const RESCAN_AFTER_MS = 25_000;

function removeError(error: unknown): string {
  if (error instanceof ApiError && error.status === 502) {
    return `Radarr of Sonarr gaf een fout: ${error.message}`;
  }
  return errorText(error);
}

export function RemoveSheet({
  itemId,
  target,
  onClose,
  onRemoved,
}: {
  itemId: string;
  target: RemoveTarget;
  onClose: () => void;
  /** After a successful removal (a whole title: leave its page). */
  onRemoved?: () => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ['remove', itemId, target],
    queryFn: () => api.removePreview(itemId, target),
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => api.remove(itemId, target),
    onSuccess: () => {
      // Once the scan has dropped what is gone.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['items'] });
        void queryClient.invalidateQueries({ queryKey: ['item'] });
        void queryClient.invalidateQueries({ queryKey: ['libraries'] });
        void queryClient.invalidateQueries({ queryKey: ['continue'] });
      }, RESCAN_AFTER_MS);
    },
  });
  const data = preview.data;
  const tool = data?.service === 'radarr' ? 'Radarr' : 'Sonarr';
  const what =
    target.scope === 'title'
      ? data?.service === 'radarr'
        ? 'de film'
        : 'de serie'
      : target.scope === 'season'
        ? 'dit seizoen'
        : 'deze aflevering';

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Sluiten" onPress={onClose} />
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={styles.head}>
            <View style={styles.icon}>
              <Icon name="trash" size={24} color={colors.danger} />
            </View>
            <Text style={[text.h2, { flex: 1 }]}>Verwijderen</Text>
          </View>

          {preview.isPending && <ActivityIndicator color={colors.brass} />}
          {preview.isError && <Text style={styles.error}>{removeError(preview.error)}</Text>}

          {data && !remove.isSuccess && (
            <>
              <Text style={styles.label}>{data.label}</Text>
              <Text style={text.body}>
                {`${tool} verwijdert ${what} met ${
                  data.files === 1 ? '1 bestand' : `${data.files} bestanden`
                } (${sizeLabel(data.sizeBytes)}) van de schijf.`}
                {target.scope === 'title'
                  ? ` Ook de map gaat weg, en ${tool} volgt de titel niet meer.`
                  : ' Sonarr zoekt deze afleveringen daarna niet opnieuw.'}
              </Text>
              {data.unknownFiles > 0 && (
                <Text style={text.muted}>
                  {data.unknownFiles === 1
                    ? '1 bestand kent Sonarr niet; dat blijft staan.'
                    : `${data.unknownFiles} bestanden kent Sonarr niet; die blijven staan.`}
                </Text>
              )}
              <Text style={styles.warning}>Dit kan niet ongedaan worden gemaakt.</Text>
              {remove.isError && <Text style={styles.error}>{removeError(remove.error)}</Text>}
              <View style={styles.buttons}>
                <Button label="Annuleren" kind="secondary" style={{ flex: 1 }} onPress={onClose} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${data.label} verwijderen`}
                  disabled={remove.isPending}
                  onPress={() => remove.mutate()}
                  style={({ pressed }) => [
                    styles.danger,
                    (pressed || remove.isPending) && { opacity: 0.7 },
                  ]}
                >
                  {remove.isPending ? (
                    <ActivityIndicator color={colors.ink} />
                  ) : (
                    <Text style={styles.dangerText}>Verwijderen</Text>
                  )}
                </Pressable>
              </View>
            </>
          )}

          {remove.isSuccess && (
            <>
              <Text style={styles.label}>{data?.label}</Text>
              <Text style={text.body}>
                {tool} heeft het verwijderd. CineVault werkt de bibliotheek over een halve minuut
                bij.
              </Text>
              <Button
                label="Klaar"
                onPress={() => {
                  onClose();
                  onRemoved?.();
                }}
              />
            </>
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
  sheet: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    padding: 20,
    gap: 14,
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(240,138,122,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: colors.text, fontSize: 17, fontWeight: '800' },
  warning: { color: colors.danger, fontSize: 14, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 14 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 4 },
  danger: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.s,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: { color: colors.ink, fontSize: 16, fontWeight: '800' },
});
