// The chosen subtitle as cues in file time (seconds from the start of the
// file), as in the web app's useSubtitles: a whole subtitle at once, or an
// embedded track that the server reads from where the viewer is.

import {
  chooseSubtitle,
  type Cue,
  type MediaFileDto,
  mergeCues,
  parseVtt,
  readingAsText,
  type SubtitleExtraction,
  type SubtitleOption,
} from '@cinevault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keys } from '../keys';
import { savedSubtitlePreference, saveSubtitlePreference } from '../preferences';
import { useSession } from '../session';

const POLL_MS = 3_000;
/** Read from a little before the position, for a line that is already on screen. */
const LEAD_IN = 10;
/** Start reading elsewhere when the viewer is this far beyond what was read. */
const AHEAD_RESTART = 120;

export type CueStatus =
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'reading'; covered: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useCues({
  file,
  position,
  audioLanguage,
  forShow,
  onChoose,
}: {
  file: MediaFileDto;
  /** Seconds from the start of the file. */
  position: number;
  audioLanguage: string | undefined;
  /** "off" or a language, as chosen for this show (TrackChoice.subtitle). */
  forShow?: string | undefined;
  /** The viewer chose: "off", a language, or null (one without a language). */
  onChoose?: (value: string | null) => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: keys.subtitles(file.id),
    queryFn: () => api.subtitles(file.id),
    // A picture subtitle being read as text: its progress, and when it is done.
    refetchInterval: (query) => (readingAsText(query.state.data ?? []) ? POLL_MS : false),
  });

  const [chosen, setChosen] = useState<string | null>();
  const automatic = useMemo(
    () =>
      options.data
        ? (chooseSubtitle(options.data, audioLanguage, savedSubtitlePreference(), forShow)?.id ??
          null)
        : undefined,
    [options.data, audioLanguage, forShow],
  );
  const selectedId = chosen === undefined ? automatic : chosen;
  const selected = options.data?.find((o) => o.id === selectedId);

  const [shiftMs, setShiftMs] = useState<number>();
  const [loaded, setLoaded] = useState<{ id: string; cues: Cue[] }>();
  const cues = useMemo(
    () => (loaded && loaded.id === selectedId ? loaded.cues : []),
    [loaded, selectedId],
  );
  const [statusOf, setStatusOf] = useState<{ id: string; status: CueStatus }>();
  const status: CueStatus = !selected
    ? { kind: 'off' }
    : statusOf?.id === selected.id
      ? statusOf.status
      : { kind: 'loading' };

  const [readFrom, setReadFrom] = useState<{ id: string; start: number }>();
  const coveredRef = useRef<{ start: number; covered: number; complete: boolean }>(undefined);

  // 1. A whole subtitle at once (sidecar, download, or an embedded track read before).
  useEffect(() => {
    if (!selected?.url) return;
    let cancelled = false;
    const id = selected.id;
    api.subtitleText(selected.url).then(
      (vtt) => {
        if (cancelled) return;
        setLoaded({ id, cues: parseVtt(vtt) });
        setStatusOf({ id, status: { kind: 'ready' } });
      },
      (error: unknown) => {
        if (!cancelled) setStatusOf({ id, status: { kind: 'error', message: message(error) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, selected?.id, selected?.url]);

  // 2. An embedded track, read by the server from `readFrom`.
  const streamIndex = selected?.url ? undefined : selected?.streamIndex;
  const readStart = readFrom && readFrom.id === selectedId ? readFrom.start : undefined;
  useEffect(() => {
    if (streamIndex === undefined || !selectedId || readStart === undefined) return;
    const id = selectedId;
    let cancelled = false;
    let job: SubtitleExtraction | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    coveredRef.current = { start: readStart, covered: readStart, complete: false };

    async function poll() {
      if (!job || cancelled) return;
      try {
        const result = await api.extracted(job.id);
        if (cancelled) return;
        const added = parseVtt(result.vtt);
        setLoaded((current) => ({
          id,
          cues: mergeCues(current?.id === id ? current.cues : [], added),
        }));
        coveredRef.current = {
          start: job.start,
          covered: result.covered,
          complete: result.complete,
        };
        setStatusOf({
          id,
          status: result.complete
            ? { kind: 'ready' }
            : { kind: 'reading', covered: result.covered },
        });
        if (result.complete) {
          if (job.start === 0)
            void queryClient.invalidateQueries({ queryKey: keys.subtitles(file.id) });
          job = undefined;
          return;
        }
      } catch (error) {
        if (!cancelled) setStatusOf({ id, status: { kind: 'error', message: message(error) } });
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    }

    api.extractSubtitles(file.id, streamIndex, readStart).then(
      (started) => {
        if (cancelled) {
          void api.stopExtraction(started.id).catch(() => {});
          return;
        }
        job = started;
        void poll();
      },
      (error: unknown) => {
        if (!cancelled) setStatusOf({ id, status: { kind: 'error', message: message(error) } });
      },
    );
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (job) void api.stopExtraction(job.id).catch(() => {});
    };
  }, [api, file.id, selectedId, streamIndex, readStart, queryClient]);

  // Start (or restart) reading an embedded track where the viewer is.
  useEffect(() => {
    if (streamIndex === undefined || !selectedId) return;
    const read = coveredRef.current;
    const outside =
      readStart === undefined ||
      position < (read?.start ?? readStart) - 1 ||
      (!read?.complete && position > (read?.covered ?? readStart) + AHEAD_RESTART);
    if (outside) {
      const timer = setTimeout(
        () => setReadFrom({ id: selectedId, start: Math.max(0, Math.floor(position - LEAD_IN)) }),
        0,
      );
      return () => clearTimeout(timer);
    }
  }, [streamIndex, selectedId, position, readStart]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changeShift = useCallback(
    (ms: number) => {
      if (!selected) return;
      setShiftMs(ms);
      clearTimeout(saveTimer.current);
      const id = selected.id;
      saveTimer.current = setTimeout(() => {
        void api.setSubtitleOffset(file.id, id, ms).then(
          () => queryClient.invalidateQueries({ queryKey: keys.subtitles(file.id) }),
          () => {},
        );
      }, 800);
    },
    [api, file.id, selected, queryClient],
  );
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // A picture subtitle the viewer asked to read: chosen once it is text.
  const [awaiting, setAwaiting] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const readAsText = useCallback(
    async (option: SubtitleOption) => {
      if (option.streamIndex === undefined) return;
      setReadError(undefined);
      try {
        const updated = await api.readSubtitle(file.id, option.streamIndex);
        queryClient.setQueryData<SubtitleOption[]>(keys.subtitles(file.id), (list) =>
          list?.map((o) => (o.id === updated.id ? updated : o)),
        );
        setAwaiting(option.id);
      } catch (error) {
        setReadError(message(error));
      }
    },
    [api, file.id, queryClient],
  );
  const ready = awaiting ? options.data?.find((o) => o.id === awaiting && o.supported) : undefined;
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      setAwaiting(undefined);
      setChosen(ready.id);
      setShiftMs(undefined);
      saveSubtitlePreference(ready.language ?? 'und');
      onChoose?.(ready.language ?? null);
    }, 0);
    return () => clearTimeout(timer);
  }, [ready, onChoose]);

  const select = useCallback(
    (id: string | null) => {
      setChosen(id);
      setShiftMs(undefined);
      const option = options.data?.find((o) => o.id === id);
      saveSubtitlePreference(option?.language ?? (id ? 'und' : 'off'));
      onChoose?.(id ? (option?.language ?? null) : 'off');
    },
    [options.data, onChoose],
  );

  return {
    options: options.data ?? [],
    selected,
    select,
    status,
    cues,
    shiftMs: shiftMs ?? selected?.offsetMs ?? 0,
    changeShift,
    /** Ask the server to read a picture subtitle as text; it is chosen when done. */
    readAsText,
    readError,
    added: (option: SubtitleOption) => {
      void queryClient.invalidateQueries({ queryKey: keys.subtitles(file.id) });
      // Not in the list yet: its language comes with it.
      setChosen(option.id);
      setShiftMs(undefined);
      saveSubtitlePreference(option.language ?? 'und');
      onChoose?.(option.language ?? null);
    },
  };
}
