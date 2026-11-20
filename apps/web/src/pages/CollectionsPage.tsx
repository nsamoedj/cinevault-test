import { useQuery } from '@tanstack/react-query';
import { api, keys } from '../api.js';
import { CardSkeletons, CollectionCard } from '../components/cards.js';
import { ErrorBox } from '../components/common.js';
import { Icon } from '../components/Icon.js';

/** "Collecties": films that belong together, with two or more of them here. */
export function CollectionsPage() {
  const list = useQuery({ queryKey: keys.collections, queryFn: api.collections });
  return (
    <div className="page">
      <header className="page-head">
        <h1>Collecties</h1>
        {list.data && list.data.length > 0 && (
          <p className="muted">
            {list.data.length} {list.data.length === 1 ? 'collectie' : 'collecties'}
          </p>
        )}
      </header>
      {list.isError && <ErrorBox error={list.error} />}
      {list.data?.length === 0 && (
        <div className="empty-state">
          <Icon name="grid" size={48} />
          <h2>Nog geen collecties</h2>
          <p>
            Staan er twee of meer films van een reeks in de bibliotheek, zoals Harry Potter of Toy
            Story, dan verschijnt die hier.
          </p>
        </div>
      )}
      <ul className="collection-grid">
        {list.isPending ? (
          <CardSkeletons count={6} shape="landscape" />
        ) : (
          list.data?.map((collection) => (
            <li key={collection.id}>
              <CollectionCard collection={collection} />
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
