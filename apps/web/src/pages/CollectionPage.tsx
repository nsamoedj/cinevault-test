import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { collectionLabel } from '@cinevault/shared';
import { CardSkeletons, MissingPartCard, PosterCard } from '../components/cards.js';
import { ErrorBox } from '../components/common.js';
import { Icon } from '../components/Icon.js';

/** One collection: all its films in the order they came out, also the ones not here. */
export function CollectionPage() {
  const { id = '' } = useParams();
  const { isKid } = useAuth();
  const collection = useQuery({
    queryKey: keys.collection(Number(id)),
    queryFn: () => api.collection(Number(id)),
  });
  const data = collection.data;
  return (
    <div className="page collection-page">
      {data?.backdropUrl && (
        <div className="collection-backdrop" aria-hidden="true">
          <img src={data.backdropUrl} alt="" />
        </div>
      )}
      <header className="page-head">
        <div>
          <h1>{data?.name ?? 'Collectie'}</h1>
          {data && <p className="muted">{collectionLabel(data)}</p>}
        </div>
        {data?.next && (
          <Link to={`/items/${data.next.id}`} className="button primary">
            <Icon name="play" />{' '}
            {data.watched > 0 ? `Verder met ${data.next.title}` : `Begin met ${data.next.title}`}
          </Link>
        )}
      </header>
      {data?.overview && <p className="collection-overview">{data.overview}</p>}
      {collection.isError && <ErrorBox error={collection.error} />}
      <ol className="poster-grid">
        {collection.isPending ? (
          <CardSkeletons count={6} />
        ) : (
          data?.parts.map((part) => (
            <li key={part.tmdbId}>
              {part.item ? (
                <PosterCard item={part.item} />
              ) : (
                <MissingPartCard part={part} canAsk={!isKid} />
              )}
            </li>
          ))
        )}
      </ol>
    </div>
  );
}
