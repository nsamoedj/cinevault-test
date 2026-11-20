import { type DownloadEntry, type MediaRequestDto, requestPartsLabel } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { ErrorBox, Poster } from '../components/common.js';
import { DiscoverTabs, StatusChip } from '../components/discover.js';
import { DownloadLine } from '../components/Download.js';
import { Icon } from '../components/Icon.js';

function useRefreshRequests() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.requests }),
      queryClient.invalidateQueries({ queryKey: ['discover'] }),
    ]);
}

function RequestRow({ request }: { request: MediaRequestDto }) {
  const { user, isAdmin } = useAuth();
  const refresh = useRefreshRequests();
  const [anime, setAnime] = useState(request.anime);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const approve = useMutation({
    mutationFn: () => api.approveRequest(request.id, request.kind === 'show' ? { anime } : {}),
    onSettled: refresh,
  });
  const decline = useMutation({
    mutationFn: () => api.declineRequest(request.id, reason.trim() || undefined),
    onSuccess: () => setDeclining(false),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRequest(request.id),
    onSettled: refresh,
  });
  const mine = request.requestedBy.some((r) => r.id === user?.id);
  const open = request.status === 'PENDING' || request.status === 'FAILED';
  const who = request.requestedBy.map((r) => r.displayName).join(', ');

  const submitDecline = (event: FormEvent) => {
    event.preventDefault();
    decline.mutate();
  };

  return (
    <li className="request-row">
      <Poster url={request.posterUrl} title={request.title} className="request-poster small" />
      <div className="request-text">
        <div className="request-head">
          <strong>
            {request.title}
            {request.year ? ` (${request.year})` : ''}
          </strong>
          <StatusChip status={request.status} />
        </div>
        {requestPartsLabel(request) && (
          <span className="request-parts">{requestPartsLabel(request)}</span>
        )}
        <span className="muted">
          {request.kind === 'movie' ? 'Film' : request.anime ? 'Anime' : 'Serie'} · gevraagd door{' '}
          {who}
          {request.decidedBy && request.status !== 'PENDING' ? ` · ${request.decidedBy}` : ''}
        </span>
        {request.download && <DownloadLine download={request.download} />}
        {request.reason && <p className="request-reason">{request.reason}</p>}
        <div className="request-actions">
          {request.itemId && (
            <Link to={`/items/${request.itemId}`} className="button glass">
              <Icon name="play" /> Bekijken
            </Link>
          )}
          {isAdmin && open && (
            <>
              {request.kind === 'show' && (
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={anime}
                    onChange={(e) => setAnime(e.target.checked)}
                  />
                  Anime
                </label>
              )}
              <button
                type="button"
                className="button primary"
                disabled={approve.isPending}
                onClick={() => approve.mutate()}
              >
                <Icon name="check" />{' '}
                {request.status === 'FAILED' ? 'Opnieuw proberen' : 'Goedkeuren'}
              </button>
              {request.status === 'PENDING' && !declining && (
                <button type="button" className="button glass" onClick={() => setDeclining(true)}>
                  <Icon name="close" /> Afwijzen
                </button>
              )}
            </>
          )}
          {!isAdmin && mine && request.status === 'PENDING' && (
            <button
              type="button"
              className="button glass"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Intrekken
            </button>
          )}
          {isAdmin && !open && request.status !== 'AVAILABLE' && (
            <button type="button" className="link-button" onClick={() => remove.mutate()}>
              Verwijderen
            </button>
          )}
        </div>
        {declining && (
          <form className="decline-form" onSubmit={submitDecline}>
            <input
              aria-label="Waarom niet? (optioneel)"
              placeholder="Waarom niet? (optioneel)"
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
            />
            <button type="submit" className="button glass" disabled={decline.isPending}>
              Afwijzen
            </button>
            <button type="button" className="link-button" onClick={() => setDeclining(false)}>
              Annuleren
            </button>
          </form>
        )}
        {(approve.isError || decline.isError || remove.isError) && (
          <ErrorBox error={approve.error ?? decline.error ?? remove.error} />
        )}
      </div>
    </li>
  );
}

/** "Verzoeken": what the household asked for; admins approve it here. */
/** A title in the queue of Radarr or Sonarr. */
function DownloadRow({ entry }: { entry: DownloadEntry }) {
  const body = (
    <>
      <Poster url={entry.posterUrl} title={entry.title} className="request-poster small" />
      <div className="download-text">
        <strong>{entry.title}</strong>
        <DownloadLine download={entry} />
      </div>
    </>
  );
  return (
    <li className="download-row">
      {entry.itemId ? (
        <Link to={`/items/${entry.itemId}`} className="download-row-link">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

export function RequestsPage() {
  const requests = useQuery({
    queryKey: keys.requests,
    queryFn: api.requests,
    refetchInterval: (query) => (query.state.data?.some((r) => r.download) ? 15_000 : false),
  });
  // Radarr's and Sonarr's queue, refreshed while the page is open.
  const downloads = useQuery({
    queryKey: ['downloads'],
    queryFn: api.downloads,
    refetchInterval: 10_000,
  });
  return (
    <div className="page requests-page">
      <header className="page-head">
        <div>
          <h1>Verzoeken</h1>
          <p className="muted">
            Wat er is aangevraagd. Iets nieuws aanvragen doe je onder{' '}
            <Link to="/discover">Ontdekken</Link>.
          </p>
        </div>
      </header>
      <DiscoverTabs />
      {downloads.data && downloads.data.length > 0 && (
        <section aria-label="Wordt gedownload">
          <h2 className="section-title">Wordt gedownload</h2>
          <ul className="download-list">
            {downloads.data.map((entry) => (
              <DownloadRow key={`${entry.kind}-${entry.tmdbId ?? entry.title}`} entry={entry} />
            ))}
          </ul>
          <h2 className="section-title">Aangevraagd</h2>
        </section>
      )}
      {requests.isError && <ErrorBox error={requests.error} />}
      {requests.data?.length === 0 && (
        <div className="empty-state">
          <Icon name="compass" size={44} />
          <p>Nog geen verzoeken.</p>
          <Link to="/discover" className="button primary">
            Naar Ontdekken
          </Link>
        </div>
      )}
      <ul className="request-list">
        {requests.data?.map((request) => (
          <RequestRow key={request.id} request={request} />
        ))}
      </ul>
    </div>
  );
}
