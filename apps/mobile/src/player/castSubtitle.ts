// A subtitle for the Chromecast: the receiver loads one whole WebVTT file, so
// an embedded track (or a picture track) is made ready on the server first
// (POST …/subtitles/:id/prepare), asked again every few seconds. When it has
// a url, the subtitle list (and so the chosen subtitle) gets it, and the cast
// loads it.

import { type SubtitleOption, castSubtitleNote, castSubtitlePending } from '@cinevault/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keys } from '../keys';
import { useSession } from '../session';

const ASK_MS = 3_000;

export function useCastSubtitle(
  fileId: string,
  option: SubtitleOption | undefined,
  active: boolean,
): { note?: string; error?: string } {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ id: string; option?: SubtitleOption; error?: string }>();
  const pending = active && castSubtitlePending(option);
  const id = option?.id;
  useEffect(() => {
    if (!pending || !id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const prepared = await api.prepareSubtitle(fileId, id);
        if (stopped) return;
        if (prepared.url) {
          queryClient.setQueryData<SubtitleOption[]>(keys.subtitles(fileId), (list) =>
            list?.map((o) => (o.id === prepared.id ? prepared : o)),
          );
          setState(undefined);
          return;
        }
        setState({ id, option: prepared });
      } catch (error) {
        if (stopped) return;
        setState({ id, error: error instanceof Error ? error.message : String(error) });
      }
      timer = setTimeout(() => void ask(), ASK_MS);
    };
    void ask();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, queryClient, fileId, id, pending]);
  if (!pending || !option) return {};
  const current = state?.id === option.id ? state : undefined;
  if (current?.error) return { error: `Ondertitels voor de tv: ${current.error}` };
  const note = castSubtitleNote(current?.option ?? option);
  return note ? { note } : {};
}
