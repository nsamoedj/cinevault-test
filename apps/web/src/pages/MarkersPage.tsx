// Beheer: the intro, recap, credits and preview of every episode of a season,
// on a timeline, with how sure the search is. One episode's intro (or
// credits) on all of the season, the whole season looked at again, and the
// player to set a part by hand (Instellingen → Intro … "Begint hier").

import {
  type MarkerDto,
  type MarkerKind,
  MARKER_KINDS,
  MIN_MARKER_CONFIDENCE,
  type SeasonMarkers,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { api, keys } from '../api.js';
import { ErrorBox, Loading } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { confidenceLabel, NAME, SOURCE } from '../components/SkipIntro.js';
import { clockLabel, seasonLabel } from '../format.js';
import { AdminFrame } from './AdminPage.js';

type Episode = SeasonMarkers['episodes'][number];

function sourceLabel(source: string): string {
  return SOURCE[source as keyof typeof SOURCE] ?? source;
}

/** The episode's parts as blocks on its length. */
function Timeline({ episode }: { episode: Episode }) {
  const length =
    episode.durationMs ??
    Math.max(1, ...Object.values(episode.markers).map((m) => (m ? m.endMs : 0)));
  return (
    <div className="marker-timeline" aria-hidden="true">
      {MARKER_KINDS.map((kind) => {
        const marker = episode.markers[kind];
        if (!marker) return null;
        const uncertain =
          marker.confidence !== undefined && marker.confidence < MIN_MARKER_CONFIDENCE;
        return (
          <span
            key={kind}
            className={`marker-block ${kind}${uncertain ? ' uncertain' : ''}`}
            style={{
              left: `${(marker.startMs / length) * 100}%`,
              width: `${Math.max(0.6, ((marker.endMs - marker.startMs) / length) * 100)}%`,
            }}
            title={`${NAME[kind].title}: ${clockLabel(marker.startMs / 1000)} tot ${clockLabel(marker.endMs / 1000)}`}
          />
        );
      })}
    </div>
  );
}

function MarkerLine({ kind, marker }: { kind: MarkerKind; marker: MarkerDto }) {
  const uncertain = marker.confidence !== undefined && marker.confidence < MIN_MARKER_CONFIDENCE;
  const sure = confidenceLabel(marker.confidence);
  return (
    <li className={uncertain ? 'uncertain' : undefined}>
      <span className={`marker-dot ${kind}`} aria-hidden="true" />
      <strong>{NAME[kind].title}</strong> {clockLabel(marker.startMs / 1000)} tot{' '}
      {clockLabel(marker.endMs / 1000)}
      <span className="muted">
        {' '}
        · {sourceLabel(marker.source)}
        {sure ? ` · ${sure}` : ''}
      </span>
    </li>
  );
}

function EpisodeRow({
  episode,
  seasonId,
  onCopied,
}: {
  episode: Episode;
  seasonId: string;
  onCopied: (next: SeasonMarkers) => void;
}) {
  const copy = useMutation({
    mutationFn: (kind: 'intro' | 'credits') =>
      api.copyMarker(seasonId, { fileId: episode.fileId, kind }),
    onSuccess: onCopied,
  });
  const copyTo = (kind: 'intro' | 'credits') => {
    const what = kind === 'intro' ? 'de intro' : 'de aftiteling (vanaf het einde)';
    if (
      window.confirm(
        `${what[0]?.toUpperCase()}${what.slice(1)} van aflevering ${episode.episodeNumber} met de hand op alle afleveringen van dit seizoen zetten? Wat daar gevonden is, wordt vervangen.`,
      )
    ) {
      copy.mutate(kind);
    }
  };
  const found = MARKER_KINDS.filter((kind) => episode.markers[kind]);
  return (
    <li className="marker-row">
      <div className="marker-row-head">
        <div>
          <strong>
            A{episode.episodeNumber}
            {episode.title ? ` · ${episode.title}` : ''}
          </strong>
          {episode.pending.length > 0 && (
            <p className="muted small">
              Zoekt nog: {episode.pending.map((kind) => NAME[kind].name).join(', ')}
            </p>
          )}
        </div>
        <Link
          className="button secondary small"
          to={`/play/${episode.fileId}`}
          title="In de speler: Instellingen → Begint hier / Eindigt hier"
        >
          <Icon name="play" /> Aanpassen in de speler
        </Link>
      </div>
      <Timeline episode={episode} />
      {found.length > 0 ? (
        <ul className="marker-lines">
          {found.map((kind) => {
            const marker = episode.markers[kind];
            return marker ? <MarkerLine key={kind} kind={kind} marker={marker} /> : null;
          })}
        </ul>
      ) : (
        episode.pending.length === 0 && <p className="muted small">Niets gevonden.</p>
      )}
      {(episode.markers.intro || episode.markers.credits) && (
        <div className="actions">
          {episode.markers.intro && (
            <button
              type="button"
              className="button secondary small"
              disabled={copy.isPending}
              onClick={() => copyTo('intro')}
            >
              Intro naar alle afleveringen
            </button>
          )}
          {episode.markers.credits && (
            <button
              type="button"
              className="button secondary small"
              disabled={copy.isPending}
              onClick={() => copyTo('credits')}
            >
              Aftiteling naar alle afleveringen
            </button>
          )}
        </div>
      )}
      {copy.isError && <ErrorBox error={copy.error} />}
    </li>
  );
}

export function MarkersPage() {
  const { seasonId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const markers = useQuery({
    queryKey: keys.seasonMarkers(seasonId),
    queryFn: () => api.seasonMarkers(seasonId),
    // While the server looks: again every 15 s.
    refetchInterval: (query) =>
      query.state.data?.episodes.some((e) => e.pending.length > 0) ? 15_000 : false,
  });
  const set = (next: SeasonMarkers) => queryClient.setQueryData(keys.seasonMarkers(seasonId), next);
  const detect = useMutation({
    mutationFn: () => api.detectSeasonMarkers(seasonId),
    onSuccess: set,
  });

  if (markers.isPending) {
    return (
      <AdminFrame title="Intro, recap en aftiteling">
        <Loading />
      </AdminFrame>
    );
  }
  if (markers.isError) {
    return (
      <AdminFrame title="Intro, recap en aftiteling">
        <ErrorBox error={markers.error} />
      </AdminFrame>
    );
  }
  const data = markers.data;
  const uncertain = data.episodes.reduce(
    (n, e) =>
      n +
      Object.values(e.markers).filter(
        (m) => m?.confidence !== undefined && m.confidence < MIN_MARKER_CONFIDENCE,
      ).length,
    0,
  );
  return (
    <AdminFrame title="Intro, recap en aftiteling">
      <section className="panel markers-page">
        <div className="markers-head">
          <div>
            <Link to={`/items/${data.itemId}`} className="muted">
              <Icon name="back" /> {data.title}
            </Link>
            <h2>{seasonLabel(data.seasonNumber)}</h2>
          </div>
          {data.seasons.length > 1 && (
            <label className="field select-field">
              <span className="visually-hidden">Seizoen</span>
              <select
                value={data.seasonId}
                onChange={(e) => void navigate(`/admin/markers/${e.target.value}`)}
              >
                {data.seasons.map((s) => (
                  <option key={s.id} value={s.id}>
                    {seasonLabel(s.seasonNumber)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <ul className="marker-legend" aria-label="Kleuren">
          {MARKER_KINDS.map((kind) => (
            <li key={kind}>
              <span className={`marker-dot ${kind}`} aria-hidden="true" /> {NAME[kind].title}
            </li>
          ))}
          <li>
            <span className="marker-dot uncertain" aria-hidden="true" /> te onzeker voor de spelers
          </li>
        </ul>
        <p className="muted small">
          Hoe zeker: het deel van de afleveringen waarin de server hetzelfde vond (hoofdstukken en
          AniSkip gelden als zeker). Onder de helft tonen de spelers geen knop. Met de hand
          instellen gaat in de speler, onder Instellingen; wat je daar zet, blijft staan.
        </p>
        {uncertain > 0 && (
          <p className="small">
            {uncertain === 1 ? '1 deel is' : `${uncertain} delen zijn`} te onzeker voor de spelers.
          </p>
        )}
        <div className="actions">
          <button
            type="button"
            className="button secondary"
            disabled={detect.isPending}
            onClick={() => detect.mutate()}
          >
            <Icon name="refresh" /> Seizoen opnieuw zoeken
          </button>
          <span className="muted small">Niet wat met de hand is ingesteld.</span>
        </div>
        {detect.isError && <ErrorBox error={detect.error} />}
        <ul className="marker-list">
          {data.episodes.map((episode) => (
            <EpisodeRow
              key={episode.fileId}
              episode={episode}
              seasonId={data.seasonId}
              onCopied={set}
            />
          ))}
        </ul>
      </section>
    </AdminFrame>
  );
}
