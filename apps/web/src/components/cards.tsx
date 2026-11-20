import {
  airDateLabel,
  type CollectionPart,
  canRequestPart,
  collectionLabel,
  type CollectionSummary,
  type ContinueEntry,
  isRecent,
  missingPartLabel,
  type ItemSummary,
  type NewEpisodes,
  newEpisodesLabel,
  type UpcomingEpisode,
  upcomingLabel,
} from '@cinevault/shared';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { clockLabel } from '../format.js';
import { Poster } from './common.js';
import { Icon } from './Icon.js';

/** A thin bar at the bottom of an image: how far the profile got. */
export function ProgressBar({ share, label }: { share: number; label?: string }) {
  return (
    <span
      className="progress-bar"
      style={{ '--share': `${Math.min(1, Math.max(0, share)) * 100}%` } as CSSProperties}
      {...(label && { title: label })}
    >
      {label && <span className="visually-hidden">{label}</span>}
    </span>
  );
}

export function WatchedBadge() {
  return (
    <span className="watched-badge" title="Gezien">
      <Icon name="check" />
      <span className="visually-hidden">Gezien</span>
    </span>
  );
}

/** Watched mark, or how far a movie or show is: for the signed-in profile. */
function PosterProgress({ item }: { item: ItemSummary }) {
  const progress = item.progress;
  if (!progress) return null;
  if (progress.watched) return <WatchedBadge />;
  const share =
    progress.fraction ??
    (progress.totalEpisodes ? (progress.watchedEpisodes ?? 0) / progress.totalEpisodes : 0);
  if (share <= 0) return null;
  const label = progress.totalEpisodes
    ? `${progress.watchedEpisodes} van ${progress.totalEpisodes} afleveringen gezien`
    : `${Math.round(share * 100)}% gezien`;
  return <ProgressBar share={share} label={label} />;
}

export function PosterCard({ item }: { item: ItemSummary }) {
  return (
    <Link to={`/items/${item.id}`} className="card poster-card">
      <span className="card-image poster-frame">
        <Poster url={item.posterUrl} title={item.title} />
        <PosterProgress item={item} />
        {item.metadataStatus !== 'MATCHED' && (
          <span className={`status-badge ${item.metadataStatus.toLowerCase()}`}>
            {item.metadataStatus === 'FAILED' ? 'Mislukt' : 'Niet gematcht'}
          </span>
        )}
      </span>
      <span className="card-title">{item.title}</span>
      {item.year && <span className="card-sub">{item.year}</span>}
    </Link>
  );
}

function continueSubtitle(entry: ContinueEntry): string {
  const episode = entry.episode;
  if (!episode) return entry.item.year ? String(entry.item.year) : 'Film';
  const code = `S${episode.seasonNumber} · A${episode.episodeNumber}`;
  return episode.title ? `${code} · ${episode.title}` : code;
}

/** "Verder kijken": a wide card that plays straight away. */
export function ContinueCard({ entry }: { entry: ContinueEntry }) {
  const image = entry.episode?.stillUrl ?? entry.backdropUrl ?? entry.item.posterUrl;
  const share = entry.durationMs && entry.positionMs > 0 ? entry.positionMs / entry.durationMs : 0;
  const left = entry.durationMs ? entry.durationMs - entry.positionMs : undefined;
  const sub = continueSubtitle(entry);
  return (
    <Link
      to={`/play/${entry.fileId}`}
      className="card landscape-card"
      aria-label={`${entry.item.title}, ${sub}${entry.kind === 'next' ? ', volgende aflevering' : ''}`}
    >
      <span className="card-image">
        {image ? (
          <img src={image} alt="" loading="lazy" />
        ) : (
          <span className="poster-placeholder">
            <span>{entry.item.title}</span>
          </span>
        )}
        <span className="card-play" aria-hidden="true">
          <Icon name="play" />
        </span>
        {entry.kind === 'next' && <span className="card-flag">Volgende aflevering</span>}
        {share > 0 && <ProgressBar share={share} />}
      </span>
      <span className="card-title">{entry.item.title}</span>
      <span className="card-sub">
        {sub}
        {entry.kind === 'resume' && left ? ` · nog ${clockLabel(left / 1000)}` : ''}
      </span>
    </Link>
  );
}

/** "Nieuwe afleveringen": a wide card with the episode; it opens the show. */
export function NewEpisodesCard({ entry }: { entry: NewEpisodes }) {
  const image = entry.stillUrl ?? entry.item.backdropUrl ?? entry.item.posterUrl;
  const sub = newEpisodesLabel(entry);
  return (
    <Link
      to={`/items/${entry.item.id}`}
      className="card landscape-card"
      aria-label={`${entry.item.title}, ${sub}`}
    >
      <span className="card-image">
        {image ? (
          <img src={image} alt="" loading="lazy" />
        ) : (
          <span className="poster-placeholder">
            <span>{entry.item.title}</span>
          </span>
        )}
        {isRecent(entry.addedAt) && (
          <span className="card-flag">{entry.count > 1 ? `${entry.count} nieuw` : 'Nieuw'}</span>
        )}
        {entry.fraction ? <ProgressBar share={entry.fraction} /> : null}
      </span>
      <span className="card-title">{entry.item.title}</span>
      <span className="card-sub">{sub}</span>
    </Link>
  );
}

/** "Binnenkort": a wide card with the day the next episode airs; it opens the show. */
export function UpcomingCard({ entry }: { entry: UpcomingEpisode }) {
  const image = entry.item.backdropUrl ?? entry.item.posterUrl;
  const when = airDateLabel(entry.airDate);
  const sub = upcomingLabel(entry);
  return (
    <Link
      to={`/items/${entry.item.id}`}
      className="card landscape-card upcoming-card"
      aria-label={`${entry.item.title}, ${sub}, ${when}`}
    >
      <span className="card-image">
        {image ? (
          <img src={image} alt="" loading="lazy" />
        ) : (
          <span className="poster-placeholder">
            <span>{entry.item.title}</span>
          </span>
        )}
        <span className="card-flag">{when}</span>
      </span>
      <span className="card-title">{entry.item.title}</span>
      <span className="card-sub">{sub}</span>
    </Link>
  );
}

/** "3 van 5 films · 1 gezien". */
/** A collection ("Harry Potter Collection"): a wide card that opens it. */
export function CollectionCard({ collection }: { collection: CollectionSummary }) {
  const image = collection.backdropUrl ?? collection.posterUrl;
  const sub = collectionLabel(collection);
  return (
    <Link
      to={`/collections/${collection.id}`}
      className="card landscape-card collection-card"
      aria-label={`${collection.name}, ${sub}`}
    >
      <span className="card-image">
        {image ? (
          <img src={image} alt="" loading="lazy" />
        ) : (
          <span className="poster-placeholder">
            <span>{collection.name}</span>
          </span>
        )}
        {collection.owned > 0 && collection.watched >= collection.owned && <WatchedBadge />}
      </span>
      <span className="card-title">{collection.name}</span>
      <span className="card-sub">{sub}</span>
    </Link>
  );
}

/** A film of a collection that isn't here: asked for, announced, or to ask for (Ontdekken). */
export function MissingPartCard({ part, canAsk }: { part: CollectionPart; canAsk: boolean }) {
  const state = missingPartLabel(part);
  const ask = canAsk && canRequestPart(part);
  const body = (
    <>
      <span className="card-image poster-frame missing-part">
        <Poster url={part.posterUrl} title={part.title} />
        <span className="card-flag">{state}</span>
      </span>
      <span className="card-title">{part.title}</span>
      <span className="card-sub">
        {part.year ?? ''}
        {ask ? `${part.year ? ' · ' : ''}Aanvragen` : ''}
      </span>
    </>
  );
  if (ask) {
    return (
      <Link
        to={`/discover?title=movie-${part.tmdbId}`}
        className="card poster-card"
        aria-label={`${part.title}, ${state}, aanvragen`}
      >
        {body}
      </Link>
    );
  }
  return (
    <div className="card poster-card" aria-label={`${part.title}, ${state}`}>
      {body}
    </div>
  );
}

/** Grey shapes while a row or grid loads. */
export function CardSkeletons({
  count = 8,
  shape = 'poster',
}: {
  count?: number;
  shape?: 'poster' | 'landscape';
}) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} aria-hidden="true">
          <span className={`card skeleton-card ${shape}`}>
            <span className="card-image skeleton" />
            <span className="skeleton skeleton-line" />
          </span>
        </li>
      ))}
    </>
  );
}
