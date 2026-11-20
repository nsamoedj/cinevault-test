import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, keys } from '../api.js';
import { CardSkeletons, PosterCard } from '../components/cards.js';
import { ErrorBox } from '../components/common.js';
import { Icon } from '../components/Icon.js';

/** "Mijn lijst": what the profile keeps to watch, the last added first. */
export function MyListPage() {
  const list = useQuery({ queryKey: keys.myList, queryFn: api.myList });
  return (
    <div className="page">
      <header className="page-head">
        <h1>Mijn lijst</h1>
        {list.data && list.data.length > 0 && (
          <p className="muted">
            {list.data.length} {list.data.length === 1 ? 'titel' : 'titels'}
          </p>
        )}
      </header>
      {list.isError && <ErrorBox error={list.error} />}
      {list.data?.length === 0 && (
        <div className="empty-state">
          <Icon name="plus" size={48} />
          <h2>Nog niets bewaard</h2>
          <p>
            Kies <strong>Mijn lijst</strong> bij een film of serie om hem hier te bewaren. Van
            series in je lijst krijg je een melding als er een nieuwe aflevering is.
          </p>
          <Link to="/" className="button primary">
            Naar Home
          </Link>
        </div>
      )}
      <ul className="poster-grid">
        {list.isPending ? (
          <CardSkeletons count={12} />
        ) : (
          list.data?.map((item) => (
            <li key={item.id}>
              <PosterCard item={item} />
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
