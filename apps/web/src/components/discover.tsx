// "Ontdekken": cards for TMDB's titles, and the details layer with "Aanvragen".

import {
  type DiscoverItem,
  discoverPartLabel,
  type MediaRequestDto,
  type RequestStatus,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router';
import { api, keys } from '../api.js';
import { runtimeLabel } from '../format.js';
import { isBackKey } from '../spatialNav.js';
import { ErrorBox, Poster } from './common.js';
import { DownloadLine } from './Download.js';
import { Icon } from './Icon.js';
import { Rail } from './Rail.js';
import { SeasonPicker } from './SeasonPicker.js';
import { TrailerDialog } from './Trailer.js';

export const STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'Wacht op goedkeuring',
  APPROVED: 'Wordt gezocht',
  AVAILABLE: 'Staat klaar',
  DECLINED: 'Afgewezen',
  FAILED: 'Mislukt',
};

export function StatusChip({ status }: { status: RequestStatus }) {
  return <span className={`request-status ${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

/** On the poster: here already, or asked for. */
function CardFlag({ item }: { item: DiscoverItem }) {
  if (item.itemId) {
    return (
      <span className="card-flag here">
        <Icon name="check" /> In bibliotheek
      </span>
    );
  }
  if (item.request && item.request.status !== 'DECLINED') {
    return <span className="card-flag asked">{STATUS_LABEL[item.request.status]}</span>;
  }
  return null;
}

/** A poster that opens the title's details. */
export function DiscoverCard({
  item,
  onOpen,
  sub,
  current,
}: {
  item: DiscoverItem;
  onOpen: () => void;
  /** Instead of "2021 · Film". */
  sub?: string;
  /** The title whose details are open (in its collection's row). */
  current?: boolean;
}) {
  const kind = item.kind === 'movie' ? 'Film' : item.anime ? 'Anime' : 'Serie';
  return (
    <button
      type="button"
      className={`card poster-card discover-card${current ? ' current' : ''}`}
      onClick={onOpen}
      disabled={current}
      aria-current={current ? 'true' : undefined}
      aria-label={`${item.title}${item.year ? ` (${item.year})` : ''}, ${sub ?? kind}`}
    >
      <span className="card-image poster-frame">
        <Poster url={item.posterUrl} title={item.title} />
        <CardFlag item={item} />
      </span>
      <span className="card-title">{item.title}</span>
      <span className="card-sub">{sub ?? [item.year, kind].filter(Boolean).join(' · ')}</span>
    </button>
  );
}

function useRefreshDiscover() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['discover'] }),
      queryClient.invalidateQueries({ queryKey: keys.requests }),
    ]);
}

/** What happens now with a request just made. */
function askedMessage(request: MediaRequestDto): string {
  if (request.status === 'PENDING') {
    return 'Aangevraagd. Je krijgt een melding als een beheerder het goedkeurt.';
  }
  if (request.status === 'APPROVED') {
    return `Aangevraagd. ${request.kind === 'movie' ? 'Radarr' : 'Sonarr'} zoekt het nu.`;
  }
  return request.reason ?? '';
}

/** "26 okt 2026" for a release date. */
function dayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The title's details over the page: the description, the trailer, and
 * "Aanvragen"; below, its collection and "Meer zoals dit", which open
 * another title (`onOpen`).
 */
export function DiscoverDialog({
  item,
  onClose,
  onOpen,
}: {
  item: DiscoverItem;
  onClose: () => void;
  onOpen: (item: DiscoverItem) => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const [trailer, setTrailer] = useState(false);
  const closeTrailer = useCallback(() => setTrailer(false), []);
  const refresh = useRefreshDiscover();
  const details = useQuery({
    queryKey: ['discover', 'details', item.kind, item.tmdbId],
    queryFn: () => api.discoverDetails(item.kind, item.tmdbId),
    refetchInterval: (query) => (query.state.data?.download ? 15_000 : false),
  });
  const ask = useMutation({
    mutationFn: () =>
      api.createRequest({ kind: item.kind, tmdbId: item.tmdbId, anime: item.anime }),
    onSettled: refresh,
  });
  // A part of the show asked for (SeasonPicker).
  const [partAsked, setPartAsked] = useState<MediaRequestDto>();
  const data = details.data ?? item;
  const status = ask.data?.status ?? data.request?.status;
  const today = new Date().toISOString().slice(0, 10);
  const future = data.releaseDate && data.releaseDate > today;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (trailer) return;
      if (event.key === 'Escape' || isBackKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClose, trailer]);

  const facts = [
    data.year,
    data.kind === 'movie' ? 'Film' : data.anime ? 'Anime' : 'Serie',
    details.data?.runtimeMinutes && data.kind === 'movie'
      ? runtimeLabel(details.data.runtimeMinutes)
      : '',
    details.data?.seasons
      ? `${details.data.seasons} ${details.data.seasons === 1 ? 'seizoen' : 'seizoenen'}`
      : '',
  ].filter(Boolean);

  return (
    <div
      className="discover-layer"
      role="dialog"
      aria-modal="true"
      aria-label={data.title}
      data-focus-scope="modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article className="discover-sheet">
        <div className="discover-art">
          {data.backdropUrl ? <img src={data.backdropUrl} alt="" /> : null}
          <button
            ref={close}
            type="button"
            className="icon-button round discover-close"
            aria-label="Sluiten"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="discover-body">
          <Poster url={data.posterUrl} title={data.title} className="discover-poster" />
          <div className="discover-info">
            <h2>{data.title}</h2>
            <p className="meta-line">
              {data.rating ? (
                <span className="rating">
                  <Icon name="star" />{' '}
                  {data.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}
                </span>
              ) : null}
              {facts.map((fact) => (
                <span key={String(fact)}>{fact}</span>
              ))}
            </p>
            {details.data && details.data.genres.length > 0 && (
              <p className="genres">{details.data.genres.join(' · ')}</p>
            )}
            {data.releaseDate && (
              <p className="muted">
                {data.kind === 'movie'
                  ? future
                    ? `Verschijnt ${dayLabel(data.releaseDate)}`
                    : `Uitgebracht ${dayLabel(data.releaseDate)}`
                  : `Eerste aflevering ${dayLabel(data.releaseDate)}`}
              </p>
            )}
            {data.download && <DownloadLine download={data.download} large />}
            <div className="detail-actions">
              {data.itemId ? (
                <Link to={`/items/${data.itemId}`} className="button primary large">
                  <Icon name="play" /> In de bibliotheek
                </Link>
              ) : status && status !== 'DECLINED' ? (
                <StatusChip status={status} />
              ) : (
                <button
                  type="button"
                  className="button primary large"
                  disabled={ask.isPending}
                  onClick={() => ask.mutate()}
                >
                  <Icon name="plus" />{' '}
                  {status === 'DECLINED'
                    ? 'Opnieuw aanvragen'
                    : data.kind === 'show'
                      ? 'Hele serie aanvragen'
                      : 'Aanvragen'}
                </button>
              )}
              {details.data?.trailerKey && (
                <button
                  type="button"
                  className="button glass large"
                  onClick={() => setTrailer(true)}
                >
                  <Icon name="film" /> Trailer
                </button>
              )}
            </div>
            {ask.isSuccess && (
              <p role="status" className="muted">
                {askedMessage(ask.data)}
              </p>
            )}
            {future && data.kind === 'movie' && !data.itemId && (
              <p className="muted">
                Radarr downloadt een film pas als hij digitaal uitkomt. Aanvragen kan nu al.
              </p>
            )}
            {ask.isError && <ErrorBox error={ask.error} title="Aanvragen lukte niet" />}
            {details.data?.tagline && <p className="tagline">{details.data.tagline}</p>}
            {data.overview && <p className="overview">{data.overview}</p>}
            {data.kind === 'show' &&
              status !== 'PENDING' &&
              status !== 'APPROVED' &&
              details.data?.seasonList &&
              details.data.seasonList.length > 0 && (
                <SeasonPicker
                  item={data}
                  seasons={details.data.seasonList}
                  onAsked={(request) => {
                    setPartAsked(request);
                    void refresh();
                  }}
                />
              )}
            {partAsked && (
              <p role="status" className="muted">
                {askedMessage(partAsked)}
              </p>
            )}
          </div>
        </div>
        {details.data && details.data.cast.length > 0 && (
          <div className="discover-cast">
            <Rail title="Cast">
              {details.data.cast.map((person) => (
                <li key={`${person.name}-${person.character ?? ''}`}>
                  <div className="person">
                    <Poster
                      url={person.profileUrl}
                      title={person.name}
                      className="person-photo"
                      compact
                    />
                    <strong>{person.name}</strong>
                    {person.character && <span>{person.character}</span>}
                  </div>
                </li>
              ))}
            </Rail>
          </div>
        )}
        {details.data?.collection && (
          <div className="discover-cast discover-collection">
            <Rail
              title={details.data.collection.name}
              {...(details.data.collection.owned > 0 && {
                more: `/collections/${details.data.collection.id}`,
              })}
            >
              {details.data.collection.parts.map((part) => {
                const current = part.tmdbId === data.tmdbId;
                return (
                  <li key={part.tmdbId}>
                    <DiscoverCard
                      item={part}
                      sub={discoverPartLabel(part, current)}
                      current={current}
                      onOpen={() => onOpen(part)}
                    />
                  </li>
                );
              })}
            </Rail>
          </div>
        )}
        {details.data?.similar && details.data.similar.length > 0 && (
          <div className="discover-cast">
            <Rail title="Meer zoals dit">
              {details.data.similar.map((similar) => (
                <li key={`${similar.kind}-${similar.tmdbId}`}>
                  <DiscoverCard item={similar} onOpen={() => onOpen(similar)} />
                </li>
              ))}
            </Rail>
          </div>
        )}
      </article>
      {trailer && details.data?.trailerKey && (
        <TrailerDialog
          videoKey={details.data.trailerKey}
          title={data.title}
          onClose={closeTrailer}
        />
      )}
    </div>
  );
}

/** Ontdekken | Verzoeken, above both pages; the number waiting for an admin. */
export function DiscoverTabs() {
  const requests = useQuery({ queryKey: keys.requests, queryFn: api.requests });
  const waiting = requests.data?.filter((r) => r.status === 'PENDING').length ?? 0;
  return (
    <nav className="tabs" aria-label="Ontdekken en verzoeken">
      <NavLink to="/discover" end>
        Ontdekken
      </NavLink>
      <NavLink to="/requests">
        Verzoeken{waiting > 0 && <span className="tab-count">{waiting}</span>}
      </NavLink>
    </nav>
  );
}
