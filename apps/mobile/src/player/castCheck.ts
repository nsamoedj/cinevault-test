// After a cast is loaded on the TV: asks the server what the TV fetched
// (GET /cast/status/:session), so a cast that doesn't play says why: the TV
// never asked (it doesn't reach the address, or refuses http), the server
// gave it an error, or it got the stream and couldn't play it.

import { type CastProblem, castProblem } from '@cinevault/shared';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session';

/** Asked every few seconds, until it plays, for this long. */
const LOOK_MS = 3_000;
const LOOK_FOR_MS = 90_000;

export function useCastCheck(
  session: { id: string; at: number } | undefined,
  receiverError: boolean,
  playing: boolean,
): CastProblem | undefined {
  const { api } = useSession();
  const [found, setFound] = useState<{ id: string; problem?: CastProblem }>();
  const live = useRef({ receiverError, playing });
  useEffect(() => {
    live.current = { receiverError, playing };
  });
  const id = session?.id;
  const at = session?.at ?? 0;
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    const look = async () => {
      if (live.current.playing) return;
      const status = await api.castStatus(id).catch(() => undefined);
      const problem = castProblem(status, { sinceMs: Date.now() - at, ...live.current });
      if (!stopped) setFound({ id, ...(problem && { problem }) });
    };
    const timer = setInterval(() => void look(), LOOK_MS);
    const end = setTimeout(() => clearInterval(timer), LOOK_FOR_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(end);
    };
  }, [api, id, at]);
  return found && found.id === id && !playing ? found.problem : undefined;
}
