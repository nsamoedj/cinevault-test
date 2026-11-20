// Skip Intro, the recap and the end credits of the episode that plays (asked again while
// the server is still looking), and for admins a way to correct them by hand.

import {
  ApiError,
  type FileContext,
  type IntroInfo,
  type IntroRange,
  type MarkerKind,
  markerConfidenceLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, keys } from '../api.js';
import { clockLabel } from '../format.js';

const POLL_MS = 20_000;
/**
 * Asks again for about 30 minutes while the server looks: a new season's
 * episodes are compared with each other, which can take longer than 5 minutes.
 */
const POLLS = 90;
/** "Begint hier" without a known end: intros are about this long. */
const TYPICAL_SECONDS = 90;

/** The intro and credits of `context`'s file, from the file, then from the server while it looks. */
export function useIntro(context: FileContext): IntroInfo {
  const { data } = useQuery({
    queryKey: keys.intro(context.file.id),
    queryFn: () => api.intro(context.file.id),
    initialData: {
      ...(context.intro && { intro: context.intro }),
      ...(context.credits && { credits: context.credits }),
      ...(context.creditsSource && { creditsSource: context.creditsSource }),
      ...(context.moreCredits && { moreCredits: context.moreCredits }),
      ...(context.recap && { recap: context.recap }),
      ...(context.preview && { preview: context.preview }),
      pending: Boolean(context.introPending || context.creditsPending),
      introPending: Boolean(context.introPending),
      creditsPending: Boolean(context.creditsPending),
    },
    // Shown at once from the file, then asked once (with where it comes from).
    initialDataUpdatedAt: 0,
    staleTime: POLL_MS,
    refetchInterval: (query) =>
      query.state.data?.pending && query.state.dataUpdateCount < POLLS ? POLL_MS : false,
  });
  return data;
}

export const SOURCE: Record<NonNullable<IntroInfo['creditsSource']>, string> = {
  audio: 'gevonden in de audio van het seizoen',
  chapter: 'uit de hoofdstukken van het bestand',
  aniskip: 'van AniSkip',
  picture: 'gezien in het beeld; een scène erna wordt niet overgeslagen',
  manual: 'met de hand ingesteld',
};

/** Where an intro or end credits is about this long, when only one end is set. */
const TYPICAL: Record<Part, number> = {
  intro: TYPICAL_SECONDS,
  credits: 120,
  recap: 60,
  preview: 30,
};
type Part = MarkerKind;
export const NAME: Record<Part, { title: string; name: string; none: string }> = {
  intro: { title: 'Intro', name: 'intro', none: 'Geen intro' },
  credits: { title: 'Aftiteling', name: 'aftiteling', none: 'Geen aftiteling' },
  recap: { title: 'Recap', name: 'recap', none: 'Geen recap' },
  preview: { title: 'Preview', name: 'preview', none: 'Geen preview' },
};

/** How sure the search is, in words (shared with the app). */
export const confidenceLabel = markerConfidenceLabel;

/** One part (intro or credits): where it is, and setting it from the position. */
function PartEditor({
  part,
  fileId,
  range,
  source,
  pending,
  position,
  duration,
  more,
  confidence,
}: {
  part: Part;
  fileId: string;
  range: IntroRange | undefined;
  source: IntroInfo['creditsSource'];
  pending: boolean;
  position: number;
  duration: number;
  confidence?: number | undefined;
  /** A film's credits: the parts after a scene (mid-credits). */
  more?: IntroRange[] | undefined;
}) {
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
    onSuccess: (next) => {
      queryClient.setQueryData(keys.introAll(fileId), next);
      // The players' answer leaves out what is uncertain: asked again.
      void queryClient.invalidateQueries({ queryKey: keys.intro(fileId), exact: true });
    },
  });
  const { name } = NAME[part];
  const now = Math.round(position * 1000);
  const endOfFile = Math.round(duration * 1000);
  const from = (startMs: number, endMs: number) => save.mutate({ startMs, endMs });
  const typical = TYPICAL[part] * 1000;
  const defaultEnd =
    (part === 'credits' || part === 'preview') && endOfFile > 0
      ? Math.min(endOfFile, now + typical)
      : now + typical;

  return (
    <div className="choice-list intro-editor">
      <p className="legend">{NAME[part].title}</p>
      <p className="small">
        {range
          ? `${clockLabel(range.startMs / 1000)} tot ${clockLabel(range.endMs / 1000)}, ${
              source ? SOURCE[source] : 'gevonden'
            }${confidenceLabel(confidence) ? `; ${confidenceLabel(confidence)}` : ''}.`
          : pending
            ? `De server zoekt de ${name} nog.`
            : source === 'manual'
              ? `Geen ${name} (met de hand ingesteld).`
              : `Geen ${name} gevonden.`}
      </p>
      {range && more && more.length > 0 && (
        <p className="small">
          Na een scène nog{' '}
          {more
            .map((r) => `${clockLabel(r.startMs / 1000)} tot ${clockLabel(r.endMs / 1000)}`)
            .join(' en ')}
          ; ook dat slaat de knop over. Met de hand instellen maakt er één deel van.
        </p>
      )}
      <div className="intro-buttons">
        <button
          type="button"
          className="button secondary"
          disabled={save.isPending}
          onClick={() => from(now, range && range.endMs > now ? range.endMs : defaultEnd)}
        >
          Begint hier
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={save.isPending || (range ? now <= range.startMs : now < 5_000)}
          onClick={() =>
            from(range && range.startMs < now ? range.startMs : Math.max(0, now - typical), now)
          }
        >
          Eindigt hier
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={save.isPending}
          onClick={() => save.mutate(null)}
        >
          {NAME[part].none}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={save.isPending}
          onClick={() => save.mutate('detect')}
        >
          Opnieuw zoeken
        </button>
      </div>
      {save.error && (
        <p className="error small">
          {save.error instanceof ApiError ? save.error.message : String(save.error)}
        </p>
      )}
    </div>
  );
}

/** In the player's settings, for admins: where the intro and the end credits are. */
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
  // Also the parts too uncertain for the players.
  const all = useQuery({
    queryKey: keys.introAll(fileId),
    queryFn: () => api.intro(fileId, { all: true }),
  });
  const info = all.data ?? shown;
  const credits = (
    <PartEditor
      part="credits"
      fileId={fileId}
      range={info.credits}
      source={info.creditsSource}
      pending={Boolean(info.creditsPending)}
      position={position}
      duration={duration}
      more={info.moreCredits}
      confidence={info.confidence?.credits}
    />
  );
  return (
    <>
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
    </>
  );
}
