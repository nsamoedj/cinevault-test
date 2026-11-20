// "Ontdekken": ask for some seasons, or single episodes, of a show instead of
// all of it. What is here already or asked for cannot be picked again.

import {
  type DiscoverItem,
  type DiscoverSeason,
  type MediaRequestDto,
  requestPartsLabel,
} from '@cinevault/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { ErrorBox } from './common.js';
import { Icon } from './Icon.js';

const episodeKey = (season: number, episode: number) => `${season}:${episode}`;

function seasonState(season: DiscoverSeason): string {
  if (season.episodeCount > 0 && season.inLibrary >= season.episodeCount) return 'Staat er al';
  if (season.requested) return 'Aangevraagd';
  if (season.inLibrary > 0) return `${season.inLibrary} van ${season.episodeCount} hier`;
  return `${season.episodeCount} ${season.episodeCount === 1 ? 'aflevering' : 'afleveringen'}`;
}

/** "12 jan 2025". */
function shortDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

function SeasonEpisodes({
  tmdbId,
  seasonNumber,
  whole,
  picked,
  onToggle,
}: {
  tmdbId: number;
  seasonNumber: number;
  /** The whole season is picked: its episodes come with it. */
  whole: boolean;
  picked: Set<string>;
  onToggle: (key: string) => void;
}) {
  const season = useQuery({
    queryKey: ['discover', 'season', tmdbId, seasonNumber],
    queryFn: () => api.discoverSeason(tmdbId, seasonNumber),
  });
  if (season.isPending) return <p className="muted small">Afleveringen laden…</p>;
  if (season.isError) return <ErrorBox error={season.error} />;
  return (
    <ul className="episode-picks">
      {season.data.episodes.map((episode) => {
        const key = episodeKey(episode.seasonNumber, episode.episodeNumber);
        const done = episode.inLibrary || episode.requested;
        return (
          <li key={key}>
            <label className={`choice${done ? ' done' : ''}`}>
              <input
                type="checkbox"
                checked={done || whole || picked.has(key)}
                disabled={done || whole}
                onChange={() => onToggle(key)}
              />
              <span className="pick-text">
                <strong>
                  A{episode.episodeNumber}
                  {episode.title ? ` · ${episode.title}` : ''}
                </strong>
                <span className="muted small">
                  {[
                    episode.inLibrary
                      ? 'Staat er al'
                      : episode.requested
                        ? 'Aangevraagd'
                        : episode.upcoming
                          ? 'Binnenkort'
                          : '',
                    episode.airDate ? shortDate(episode.airDate) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export function SeasonPicker({
  item,
  seasons,
  onAsked,
}: {
  item: DiscoverItem;
  seasons: DiscoverSeason[];
  onAsked: (request: MediaRequestDto) => void;
}) {
  const [whole, setWhole] = useState<Set<number>>(new Set());
  const [episodes, setEpisodes] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<number>();
  const ask = useMutation({
    mutationFn: () =>
      api.createRequest({
        kind: 'show',
        tmdbId: item.tmdbId,
        anime: item.anime,
        seasons: [...whole],
        episodes: [...episodes]
          .map((key) => key.split(':').map(Number) as [number, number])
          .filter(([season]) => !whole.has(season))
          .map(([seasonNumber, episodeNumber]) => ({ seasonNumber, episodeNumber })),
      }),
    onSuccess: (request) => {
      setWhole(new Set());
      setEpisodes(new Set());
      onAsked(request);
    },
  });
  const toggleSeason = (n: number) =>
    setWhole((current) => {
      const next = new Set(current);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const toggleEpisode = (key: string) =>
    setEpisodes((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const chosen = {
    seasons: [...whole],
    episodes: [...episodes].map((key) => {
      const [seasonNumber = 0, episodeNumber = 0] = key.split(':').map(Number);
      return { seasonNumber, episodeNumber };
    }),
  };
  const label = requestPartsLabel(chosen);

  return (
    <section className="season-picker" aria-labelledby="season-picker-heading">
      <h3 id="season-picker-heading">Seizoenen of afleveringen aanvragen</h3>
      <ul className="season-picks">
        {seasons.map((season) => {
          const done =
            season.requested ||
            (season.episodeCount > 0 && season.inLibrary >= season.episodeCount);
          return (
            <li key={season.seasonNumber}>
              <div className="season-pick">
                <label className={`choice${done ? ' done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={done || whole.has(season.seasonNumber)}
                    disabled={done}
                    onChange={() => toggleSeason(season.seasonNumber)}
                  />
                  <span className="pick-text">
                    <strong>{season.name ?? `Seizoen ${season.seasonNumber}`}</strong>
                    <span className="muted small">{seasonState(season)}</span>
                  </span>
                </label>
                {!done && (
                  <button
                    type="button"
                    className="button secondary small"
                    aria-expanded={open === season.seasonNumber}
                    onClick={() =>
                      setOpen(open === season.seasonNumber ? undefined : season.seasonNumber)
                    }
                  >
                    Afleveringen{' '}
                    <Icon name={open === season.seasonNumber ? 'chevronUp' : 'chevronDown'} />
                  </button>
                )}
              </div>
              {open === season.seasonNumber && (
                <SeasonEpisodes
                  tmdbId={item.tmdbId}
                  seasonNumber={season.seasonNumber}
                  whole={whole.has(season.seasonNumber)}
                  picked={episodes}
                  onToggle={toggleEpisode}
                />
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="button primary"
        disabled={!label || ask.isPending}
        onClick={() => ask.mutate()}
      >
        <Icon name="plus" /> {label ? `${label} aanvragen` : 'Kies wat je wilt aanvragen'}
      </button>
      {ask.isError && <ErrorBox error={ask.error} title="Aanvragen lukte niet" />}
    </section>
  );
}
