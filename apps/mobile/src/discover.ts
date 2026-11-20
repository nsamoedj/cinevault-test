// "Ontdekken" on the phone and the TV: asking for a title, and its labels.

import type { DiscoverItem, RequestStatus } from '@cinevault/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys } from './keys';
import { useSession } from './session';

export const STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'Wacht op goedkeuring',
  APPROVED: 'Wordt gezocht',
  AVAILABLE: 'Staat klaar',
  DECLINED: 'Afgewezen',
  FAILED: 'Mislukt',
};

export const STATUS_COLOR: Record<RequestStatus, string> = {
  PENDING: '#E0B04F',
  APPROVED: '#8ec3f0',
  AVAILABLE: '#8fd19e',
  DECLINED: '#f08a7a',
  FAILED: '#f08a7a',
};

/** On a card: here already, or asked for. */
export function cardFlag(item: DiscoverItem): string | undefined {
  if (item.itemId) return 'In bibliotheek';
  if (item.request && item.request.status !== 'DECLINED') return STATUS_LABEL[item.request.status];
  return undefined;
}

export function kindLabel(item: DiscoverItem): string {
  return item.kind === 'movie' ? 'Film' : item.anime ? 'Anime' : 'Serie';
}

/** "10 nov 2016". */
export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function releaseLine(item: DiscoverItem): string | undefined {
  if (!item.releaseDate) return undefined;
  if (item.kind === 'show') return `Eerste aflevering ${dayLabel(item.releaseDate)}`;
  const future = item.releaseDate > new Date().toISOString().slice(0, 10);
  return `${future ? 'Verschijnt' : 'Uitgebracht'} ${dayLabel(item.releaseDate)}`;
}

/** "Aanvragen", and the feed, rows and the requests list refresh after. */
export function useAskFor(item: DiscoverItem) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.createRequest({ kind: item.kind, tmdbId: item.tmdbId, anime: item.anime }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['discover'] }),
        queryClient.invalidateQueries({ queryKey: keys.requests }),
      ]),
  });
}

/** Where a card goes: the title's details. */
export function titleRoute(item: DiscoverItem) {
  return {
    pathname: '/discover-title' as const,
    params: { kind: item.kind, id: String(item.tmdbId) },
  };
}
