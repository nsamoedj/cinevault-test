// In the phone's player, under Instellingen, for admins: where the intro, the
// recap and the end credits of this file are, set from where the video is
// (as in the web player).

import {
  ApiError,
  type IntroInfo,
  type IntroRange,
  type MarkerKind,
  markerConfidenceLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { clockLabel } from '../format';
import { keys } from '../keys';
import { useSession } from '../session';
import { colors, radius } from '../theme';

type Part = MarkerKind;

export const NAME: Record<Part, { title: string; name: string; none: string }> = {
  intro: { title: 'Intro', name: 'intro', none: 'Geen intro' },
  recap: { title: 'Recap', name: 'recap', none: 'Geen recap' },
  credits: { title: 'Aftiteling', name: 'aftiteling', none: 'Geen aftiteling' },
  preview: { title: 'Preview', name: 'preview', none: 'Geen preview' },
};

export const SOURCE: Record<string, string> = {
  chapter: 'uit de hoofdstukken',
  audio: 'gevonden in de audio van het seizoen',
  aniskip: 'van AniSkip',
  picture: 'gezien in het beeld; een scène erna wordt niet overgeslagen',
  manual: 'met de hand ingesteld',
};

/** About this long, when only one end is set. */
const TYPICAL: Record<Part, number> = { intro: 90, credits: 120, recap: 60, preview: 30 };

function Small({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        pressed && { opacity: 0.8 },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function PartEditor({
  part,
  fileId,
  range,
  source,
  pending,
  position,
  duration,
  confidence,
}: {
  part: Part;
  fileId: string;
  range: IntroRange | undefined;
  source: string | undefined;
  pending: boolean;
  position: number;
  duration: number;
  confidence?: number | undefined;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (change: IntroRange | null | 'detect') => {
      if (part === 'intro') {
        return change === 'detect' ? api.detectIntro(fileId) : api.setIntro(fileId, change);
      }
      if (part === 'recap') {
        return change === 'detect' ? api.detectRecap(fileId) : api.setRecap(fileId, change);
      }
      if (part === 'preview') {
        return change === 'detect' ? api.detectPreview(fileId) : api.setPreview(fileId, change);
      }
      return change === 'detect' ? api.detectCredits(fileId) : api.setCredits(fileId, change);
    },
    onSuccess: (next: IntroInfo) => {
      queryClient.setQueryData(keys.introAll(fileId), next);
      // The players' answer leaves out what is uncertain: asked again.
      void queryClient.invalidateQueries({ queryKey: keys.intro(fileId), exact: true });
    },
  });
  const { name } = NAME[part];
  const now = Math.round(position * 1000);
  const endOfFile = Math.round(duration * 1000);
  const typical = TYPICAL[part] * 1000;
  const defaultEnd =
    (part === 'credits' || part === 'preview') && endOfFile > 0
      ? Math.min(endOfFile, now + typical)
      : now + typical;
  const from = (startMs: number, endMs: number) => save.mutate({ startMs, endMs });
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.legend}>{NAME[part].title}</Text>
      <Text style={styles.line}>
        {range
          ? `${clockLabel(range.startMs / 1000)} tot ${clockLabel(range.endMs / 1000)}, ${
              source ? (SOURCE[source] ?? 'gevonden') : 'gevonden'
            }${markerConfidenceLabel(confidence) ? `; ${markerConfidenceLabel(confidence)}` : ''}.`
          : pending
            ? `De server zoekt de ${name} nog.`
            : source === 'manual'
              ? `Geen ${name} (met de hand ingesteld).`
              : `Geen ${name} gevonden.`}
      </Text>
      <View style={styles.buttons}>
        <Small
          label="Begint hier"
          disabled={save.isPending}
          onPress={() => from(now, range && range.endMs > now ? range.endMs : defaultEnd)}
        />
        <Small
          label="Eindigt hier"
          disabled={save.isPending || (range ? now <= range.startMs : now < 5_000)}
          onPress={() =>
            from(range && range.startMs < now ? range.startMs : Math.max(0, now - typical), now)
          }
        />
        <Small
          label={NAME[part].none}
          disabled={save.isPending}
          onPress={() => save.mutate(null)}
        />
        <Small
          label="Opnieuw zoeken"
          disabled={save.isPending}
          onPress={() => save.mutate('detect')}
        />
      </View>
      {save.error ? (
        <Text style={styles.error}>
          {save.error instanceof ApiError ? save.error.message : String(save.error)}
        </Text>
      ) : null}
    </View>
  );
}

export function IntroEditor({
  fileId,
  info: shown,
  position,
  duration,
}: {
  fileId: string;
  info: IntroInfo;
  position: number;
  duration: number;
}) {
  const { api } = useSession();
  // Also the parts too uncertain for the players.
  const all = useQuery({
    queryKey: keys.introAll(fileId),
    queryFn: () => api.intro(fileId, { all: true }),
  });
  const info = all.data ?? shown;
  const more = info.moreCredits ?? [];
  const credits = (
    <>
      <PartEditor
        part="credits"
        fileId={fileId}
        range={info.credits}
        source={info.creditsSource}
        pending={Boolean(info.creditsPending)}
        position={position}
        duration={duration}
        confidence={info.confidence?.credits}
      />
      {info.credits && more.length > 0 ? (
        <Text style={styles.hint}>
          Na een scène nog{' '}
          {more
            .map((r) => `${clockLabel(r.startMs / 1000)} tot ${clockLabel(r.endMs / 1000)}`)
            .join(' en ')}
          ; ook dat slaat de knop over. Met de hand instellen maakt er één deel van.
        </Text>
      ) : null}
    </>
  );
  return (
    <View style={{ gap: 14 }}>
      <Text style={styles.hint}>
        Beheer: zet de video op het begin of het eind, en kies hieronder. Dat geldt voor iedereen.
      </Text>
      <PartEditor
        part="intro"
        fileId={fileId}
        range={info.intro}
        source={info.source}
        pending={info.introPending ?? info.pending}
        position={position}
        duration={duration}
        confidence={info.confidence?.intro}
      />
      <PartEditor
        part="recap"
        fileId={fileId}
        range={info.recap}
        source={info.recapSource}
        pending={Boolean(info.recapPending)}
        position={position}
        duration={duration}
        confidence={info.confidence?.recap}
      />
      {credits}
      <PartEditor
        part="preview"
        fileId={fileId}
        range={info.preview}
        source={info.previewSource}
        pending={Boolean(info.previewPending)}
        position={position}
        duration={duration}
        confidence={info.confidence?.preview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    color: colors.text3,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  line: { color: colors.text, fontSize: 15 },
  hint: { color: colors.text3, fontSize: 13, lineHeight: 18 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    minHeight: 40,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: radius.s,
    backgroundColor: 'rgba(242,244,250,0.12)',
  },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 13 },
});
