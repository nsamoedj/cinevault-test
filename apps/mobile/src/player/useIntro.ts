// Skip Intro, the recap and the end credits of the file that plays, from the file, then
// asked again while the server is still looking for them.

import type { FileContext, IntroInfo } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { keys } from '../keys';
import { useSession } from '../session';

const POLL_MS = 20_000;
/**
 * About 30 minutes: a new season's episodes are looked at one by one (each
 * compared with the others), which can take longer than the 5 minutes this was.
 */
const POLLS = 90;

export function useIntro(context: FileContext): IntroInfo {
  const { api } = useSession();
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
    },
    // Shown at once from the file, then asked once (with where it comes from).
    initialDataUpdatedAt: 0,
    staleTime: POLL_MS,
    refetchInterval: (query) =>
      query.state.data?.pending && query.state.dataUpdateCount < POLLS ? POLL_MS : false,
  });
  return data;
}
