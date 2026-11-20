import type { HomeRow } from '@cinevault/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import {
  CardSkeletons,
  CollectionCard,
  ContinueCard,
  NewEpisodesCard,
  PosterCard,
  UpcomingCard,
} from '../components/cards.js';
import { ErrorBox } from '../components/common.js';
import { Hero } from '../components/Hero.js';
import { Icon } from '../components/Icon.js';
import { Rail } from '../components/Rail.js';

function rowLink(row: HomeRow): string | undefined {
  if (row.id === 'my-list') return '/my-list';
  if (row.id === 'collections') return '/collections';
  if (!row.libraryId) return undefined;
  const params = new URLSearchParams();
  if (row.sort) params.set('sort', row.sort);
  if (row.genre) params.set('genre', row.genre);
  const query = params.toString();
  return `/libraries/${row.libraryId}${query ? `?${query}` : ''}`;
}

/** "Verder kijken": stopped halfway, or the next episode of a show. */
export function ContinueRow() {
  const entries = useQuery({ queryKey: keys.continue, queryFn: api.continueWatching });
  if (!entries.data || entries.data.length === 0) return null;
  return (
    <Rail title="Verder kijken" shape="landscape">
      {entries.data.map((entry) => (
        <li key={`${entry.item.id}-${entry.fileId}`}>
          <ContinueCard entry={entry} />
        </li>
      ))}
    </Rail>
  );
}

function EmptyLibrary() {
  const { isAdmin } = useAuth();
  return (
    <div className="empty-state">
      <Icon name="film" size={48} />
      <h1>Nog niets te zien</h1>
      {isAdmin ? (
        <>
          <p>
            Er staan nog geen titels in CineVault. Controleer of <code>MEDIA_ROOT</code> de mappen
            Movies, Series en Anime bevat, en start een scan.
          </p>
          <Link to="/admin" className="button primary">
            Naar Beheer
          </Link>
        </>
      ) : (
        <p>De bibliotheek is nog leeg. Vraag de beheerder om een scan te starten.</p>
      )}
    </div>
  );
}

export function HomePage() {
  const home = useQuery({ queryKey: keys.home, queryFn: api.home });

  if (home.isError) {
    return (
      <div className="page">
        <ErrorBox error={home.error} />
      </div>
    );
  }
  if (home.isPending) {
    return (
      <div className="home">
        <div className="hero skeleton" aria-hidden="true" />
        <div className="rows">
          <section className="rail poster" aria-busy="true">
            <header className="rail-header">
              <span className="skeleton skeleton-title" />
            </header>
            <div className="rail-viewport">
              <ul className="rail-track">
                <CardSkeletons />
              </ul>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const { featured, rows } = home.data;
  if (featured.length === 0 && rows.length === 0) {
    return (
      <div className="page">
        <EmptyLibrary />
      </div>
    );
  }

  return (
    <div className={`home${featured.length > 0 ? '' : ' no-hero'}`}>
      {featured.length > 0 && <Hero items={featured} />}
      <div className="rows">
        <ContinueRow />
        {rows.map((row) => {
          const more = rowLink(row);
          if (row.episodes) {
            return (
              <Rail key={row.id} title={row.title} shape="landscape">
                {row.episodes.map((entry) => (
                  <li key={entry.item.id}>
                    <NewEpisodesCard entry={entry} />
                  </li>
                ))}
              </Rail>
            );
          }
          if (row.collections) {
            return (
              <Rail key={row.id} title={row.title} shape="landscape" more="/collections">
                {row.collections.map((collection) => (
                  <li key={collection.id}>
                    <CollectionCard collection={collection} />
                  </li>
                ))}
              </Rail>
            );
          }
          if (row.upcoming) {
            return (
              <Rail key={row.id} title={row.title} shape="landscape" more="/calendar?scope=all">
                {row.upcoming.map((entry) => (
                  <li key={entry.item.id}>
                    <UpcomingCard entry={entry} />
                  </li>
                ))}
              </Rail>
            );
          }
          return (
            <Rail key={row.id} title={row.title} {...(more && { more })}>
              {row.items.map((item) => (
                <li key={item.id}>
                  <PosterCard item={item} />
                </li>
              ))}
            </Rail>
          );
        })}
      </div>
    </div>
  );
}
