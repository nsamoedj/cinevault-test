// "Mijn lijst": adding a title or taking it off, shown at once.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from './session';

export function useMyListToggle(itemId: string, inList: boolean) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<boolean>();
  const mutation = useMutation({
    mutationFn: (next: boolean) => api.setInMyList(itemId, next),
    onMutate: (next) => setOptimistic(next),
    onError: () => setOptimistic(undefined),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['items'] }),
        queryClient.invalidateQueries({ queryKey: ['item', itemId] }),
      ]);
      setOptimistic(undefined);
    },
  });
  const on = optimistic ?? inList;
  return {
    on,
    label: on ? 'In Mijn lijst' : 'Mijn lijst',
    toggle: () => mutation.mutate(!on),
  };
}
