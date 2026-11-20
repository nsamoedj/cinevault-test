import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { CardSkeletons, PosterCard } from '../components/cards.js';
import { ErrorBox } from '../components/common.js';
import { Icon } from '../components/Icon.js';

/** Search every library at once. */
export function SearchPage() {
  const { isKid } = useAuth();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [input, setInput] = useState(query);
  // A search changed from outside (the Zoeken tab clears it): the field follows.
  const [shown, setShown] = useState(query);
  if (shown !== query) {
    setShown(query);
    // Not when it is what was typed (trimmed): keep the space before the next word.
    if (input.trim() !== query) setInput(query);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (input.trim() !== query)
        setParams(input.trim() ? { q: input.trim() } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [input, query, setParams]);

  const results = useQuery({
    queryKey: keys.search(query),
    queryFn: () => api.search(query),
    enabled: query.length > 0,
    placeholderData: (previous) => previous,
  });

  return (
    <div className="page search-page">
      <label className="search-hero">
        <Icon name="search" />
        <input
          type="search"
          // The page is only for searching.
          autoFocus
          data-autofocus
          placeholder="Films, series en anime"
          aria-label="Zoeken in alle bibliotheken"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>

      {!query ? (
        <div className="empty-state">
          <Icon name="search" size={40} />
          <p>Zoek op titel, in alle bibliotheken tegelijk.</p>
        </div>
      ) : results.isError ? (
        <ErrorBox error={results.error} />
      ) : results.isPending ? (
        <ul className="poster-grid" aria-busy="true">
          <CardSkeletons count={12} />
        </ul>
      ) : results.data.length === 0 ? (
        <div className="empty-state">
          <p>Niets gevonden voor “{query}”.</p>
          {!isKid && (
            <Link to={`/discover?q=${encodeURIComponent(query)}`} className="button primary">
              <Icon name="plus" /> Aanvragen
            </Link>
          )}
        </div>
      ) : (
        <>
          <h1 className="results-title">
            Resultaten voor “{query}” <span className="muted">({results.data.length})</span>
          </h1>
          <ul className="poster-grid">
            {results.data.map((item) => (
              <li key={item.id}>
                <PosterCard item={item} />
              </li>
            ))}
          </ul>
          {!isKid && (
            <p className="request-hint">
              Staat het er niet tussen?{' '}
              <Link to={`/discover?q=${encodeURIComponent(query)}`}>Vraag het aan</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
