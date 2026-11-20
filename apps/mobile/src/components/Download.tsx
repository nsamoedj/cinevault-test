// "Wordt gedownload": how far Radarr or Sonarr is with a title, as a bar with
// the percentage and the time left (from GET /downloads, or the download on
// a title or request).

import { downloadEpisodesLabel, type DownloadProgress, downloadLabel } from '@cinevault/shared';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { Icon } from './Icon';

/** The age shown with a title's facts: "AL", "12+". */
export function ageFact(age: number | undefined): string {
  if (age === undefined) return '';
  return age === 0 ? 'AL' : `${age}+`;
}

export function DownloadLine({
  download,
  large,
}: {
  download: DownloadProgress;
  /** On a title's page: with a heading. */
  large?: boolean;
}) {
  const trouble = download.state === 'failed' || download.state === 'warning';
  const episodes = downloadEpisodesLabel(download.episodes);
  const share = Math.max(0.02, Math.min(1, download.progress));
  return (
    <View style={[styles.line, large && styles.large]}>
      {large && (
        <View style={styles.head}>
          <Icon name="chevronDown" size={18} color={colors.brass} />
          <Text style={styles.heading}>Wordt gedownload</Text>
          {episodes ? <Text style={styles.episodes}>{episodes}</Text> : null}
        </View>
      )}
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${share * 100}%` },
            trouble && { backgroundColor: colors.danger },
            download.state === 'queued' && { backgroundColor: colors.text3 },
          ]}
        />
      </View>
      <Text style={[styles.label, trouble && { color: colors.danger }]} numberOfLines={2}>
        {downloadLabel(download)}
        {!large && episodes ? ` · ${episodes}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { gap: 5 },
  large: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 8,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heading: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  episodes: { color: colors.text2, fontSize: 13, fontWeight: '600' },
  track: { height: 5, borderRadius: 3, backgroundColor: colors.glass, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, backgroundColor: colors.brass },
  label: { color: colors.text2, fontSize: 13 },
});
