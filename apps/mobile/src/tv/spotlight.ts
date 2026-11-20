// What the TV's header shows: the title that has the remote's focus. Cards
// put their title here when they get the focus; only the header follows it
// (useSyncExternalStore), not the rows, so moving along a row stays smooth.

import {
  airDateLabel,
  collectionLabel,
  type CollectionPart,
  type CollectionSummary,
  type ContinueEntry,
  type DiscoverItem,
  type FeaturedItem,
  type ItemSummary,
  missingPartLabel,
  type NewEpisodes,
  newEpisodesLabel,
  type UpcomingEpisode,
  upcomingLabel,
} from '@cinevault/shared';
import { useSyncExternalStore } from 'react';
import { qualityBadges } from '../components/sizes';
import { clockLabel, runtimeLabel } from '../format';
import { useBrowseThemeMusic } from '../themeMusic';

export interface Spot {
  /** Changes when the title changes: the header fades to the new one. */
  key: string;
  title: string;
  logoUrl?: string;
  backdropUrl?: string;
  /** "Film", "Serie", "Nieuwe aflevering"… */
  eyebrow?: string;
  /** Year, rating, length, genres: shown as one line. */
  facts: string[];
  /** 4K, HDR10, 5.1…: small boxed labels after the facts. */
  badges?: string[];
  /** E.g. "S2 · A5 · De haven · nog 23 min". */
  line?: string;
  overview?: string;
  /** 0-1: how far the profile got. */
  progress?: number;
  /** A title in the library: its theme music plays while the focus rests on it. */
  itemId?: string;
}

export function createSpotStore(initial?: Spot) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Spot | undefined) {
      if (next?.key === value?.key) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type SpotStore = ReturnType<typeof createSpotStore>;

export function useSpot(store: SpotStore): Spot | undefined {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The theme music of the title with the focus (renders nothing; only this follows the focus). */
export function SpotThemeMusic({ store }: { store: SpotStore }) {
  useBrowseThemeMusic(useSpot(store)?.itemId);
  return null;
}

function ratingLabel(rating: number | undefined): string {
  return rating ? `★ ${rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}` : '';
}

function kind(item: { type: string }): string {
  return item.type === 'SHOW' ? 'Serie' : 'Film';
}

function itemFacts(item: ItemSummary): string[] {
  return [
    item.year ? String(item.year) : '',
    ratingLabel(item.rating),
    item.type === 'SHOW' ? '' : runtimeLabel(item.runtimeMinutes),
    (item.genres ?? []).slice(0, 3).join(', '),
  ].filter(Boolean);
}

function share(item: ItemSummary): number | undefined {
  const progress = item.progress;
  if (!progress || progress.watched) return undefined;
  const value =
    progress.fraction ??
    (progress.totalEpisodes ? (progress.watchedEpisodes ?? 0) / progress.totalEpisodes : 0);
  return value > 0 ? value : undefined;
}

export function itemSpot(item: ItemSummary): Spot {
  return {
    key: `item-${item.id}`,
    itemId: item.id,
    title: item.title,
    ...(item.logoUrl && { logoUrl: item.logoUrl }),
    ...(item.backdropUrl && { backdropUrl: item.backdropUrl }),
    eyebrow: kind(item),
    facts: itemFacts(item),
    ...(item.overview && { overview: item.overview }),
    ...(share(item) && { progress: share(item) }),
  };
}

export function featuredSpot(item: FeaturedItem): Spot {
  return {
    ...itemSpot(item),
    key: `featured-${item.id}`,
    backdropUrl: item.backdropUrl,
    badges: qualityBadges(item.height, item.hdrFormat),
  };
}

export function continueSpot(entry: ContinueEntry): Spot {
  const episode = entry.episode;
  const code = episode ? `S${episode.seasonNumber} · A${episode.episodeNumber}` : '';
  const left =
    entry.kind === 'resume' && entry.durationMs
      ? `nog ${clockLabel((entry.durationMs - entry.positionMs) / 1000)}`
      : '';
  return {
    ...itemSpot(entry.item),
    key: `continue-${entry.item.id}-${entry.fileId}`,
    eyebrow: entry.kind === 'next' ? 'Volgende aflevering' : 'Verder kijken',
    ...((entry.backdropUrl ?? entry.item.backdropUrl) && {
      backdropUrl: entry.backdropUrl ?? entry.item.backdropUrl,
    }),
    line: [code, episode?.title, left].filter(Boolean).join(' · '),
    ...(entry.durationMs && entry.positionMs > 0
      ? { progress: entry.positionMs / entry.durationMs }
      : { progress: undefined }),
  };
}

export function newEpisodesSpot(entry: NewEpisodes): Spot {
  return {
    ...itemSpot(entry.item),
    key: `new-${entry.item.id}`,
    eyebrow: entry.count > 1 ? `${entry.count} nieuwe afleveringen` : 'Nieuwe aflevering',
    line: newEpisodesLabel(entry),
    progress: entry.fraction || undefined,
  };
}

export function upcomingSpot(entry: UpcomingEpisode): Spot {
  return {
    ...itemSpot(entry.item),
    key: `upcoming-${entry.item.id}`,
    eyebrow: `Binnenkort · ${airDateLabel(entry.airDate)}`,
    line: upcomingLabel(entry),
    progress: undefined,
  };
}

export function discoverSpot(item: DiscoverItem): Spot {
  const status = item.itemId
    ? 'In de bibliotheek'
    : item.request
      ? 'Aangevraagd'
      : item.anime
        ? 'Anime'
        : item.kind === 'show'
          ? 'Serie'
          : 'Film';
  return {
    key: `discover-${item.kind}-${item.tmdbId}`,
    ...(item.itemId && { itemId: item.itemId }),
    title: item.title,
    ...(item.backdropUrl && { backdropUrl: item.backdropUrl }),
    eyebrow: status,
    facts: [item.year ? String(item.year) : '', ratingLabel(item.rating)].filter(Boolean),
    ...(item.overview && { overview: item.overview }),
  };
}

export function collectionSpot(collection: CollectionSummary): Spot {
  return {
    key: `collection-${collection.id}`,
    title: collection.name,
    ...((collection.backdropUrl ?? collection.posterUrl) && {
      backdropUrl: collection.backdropUrl ?? collection.posterUrl,
    }),
    eyebrow: 'Collectie',
    facts: [collectionLabel(collection)],
  };
}

/** A film of a collection that isn't in the library. */
export function missingPartSpot(part: CollectionPart, collection?: CollectionSummary): Spot {
  return {
    key: `part-${part.tmdbId}`,
    title: part.title,
    ...(collection?.backdropUrl && { backdropUrl: collection.backdropUrl }),
    eyebrow: missingPartLabel(part),
    facts: [part.year ? String(part.year) : ''].filter(Boolean),
  };
}
