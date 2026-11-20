import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icon.js';

/** Adds a title to "Mijn lijst" or takes it off; the button shows the new state at once. */
export function MyListButton({
  itemId,
  inList,
  compact = false,
  large = false,
}: {
  itemId: string;
  inList: boolean;
  /** Only the icon (billboard); the label is for screen readers and the tooltip. */
  compact?: boolean;
  large?: boolean;
}) {
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<boolean>();
  const on = optimistic ?? inList;
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.setInMyList(itemId, next),
    onMutate: (next) => setOptimistic(next),
    onError: () => setOptimistic(undefined),
    onSettled: async () => {
      // Everything with list marks on it starts with "items" or "item".
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['items'] }),
        queryClient.invalidateQueries({ queryKey: ['item', itemId] }),
      ]);
      setOptimistic(undefined);
    },
  });
  const label = on ? 'In Mijn lijst' : 'Mijn lijst';
  const title = on ? 'Uit Mijn lijst halen' : 'Aan Mijn lijst toevoegen';
  return (
    <button
      type="button"
      className={`${compact ? 'icon-button round' : `button glass${large ? ' large' : ''}`} list-toggle${on ? ' on' : ''}`}
      aria-pressed={on}
      title={title}
      onClick={() => toggle.mutate(!on)}
    >
      <Icon name={on ? 'check' : 'plus'} />
      {compact ? <span className="visually-hidden">{title}</span> : <span>{label}</span>}
    </button>
  );
}
