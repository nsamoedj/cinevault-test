import type { ItemSort } from '@cinevault/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { api, keys } from '../api.js';
import { CardSkeletons, PosterCard } from '../components/cards.js';
import { ErrorBox } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { libraryLabel } from '../components/Layout.js';
import { countLabel } from '../format.js';

export { PosterCard } from '../components/cards.js';

const PAGE_SIZE = 60;

const SORTS: { id: ItemSort; label: string }[] = [
  { id: 'title', label: 'Titel (A-Z)' },
  { id: 'added', label: 'Nieuw toegevoegd' },
  { id: 'year', label: 'Jaar (nieuwste eerst)' },
  { id: 'rating', label: 'Waardering' },
];

function isSort(value: string | null): value is ItemSort {
  return SORTS.some((s) => s.id === value);
}

/** Loads the next page when the end of the grid comes into view. */
export function useLoadMore(enabled: boolean, load: () => void) {
  const sentinel = useRef<HTMLDivElement>(null);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !enabled || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) latest.current();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
  return sentinel;
}

export function LibraryPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const sortParam = params.get('sort');
  const sort: ItemSort = isSort(sortParam) ? sortParam : 'title';
  const genre = params.get('genre') ?? '';
  const [input, setInput] = useState(search);
  // Another library, or a search changed from outside (the menu): the field follows.
  const [shown, setShown] = useState({ id, search });
  if (shown.id !== id || shown.search !== search) {
    setShown({ id, search });
    setInput(search);
  }

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value && !(key === 'sort' && value === 'title')) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };

  // Update the URL (and so the query) shortly after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (input === search) return;
      const next = new URLSearchParams(params);
      if (input) next.set('q', input);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [input, search, params, setParams]);

  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const all = libraries.data ?? [];
  const library = all.find((l) => l.id === id);
  const genres = useQuery({ queryKey: keys.genres(id), queryFn: () => api.genres(id) });
  const items = useInfiniteQuery({
    queryKey: keys.items(id, search, sort, genre),
    queryFn: ({ pageParam }) =>
      api.items(id, {
        page: pageParam,
        pageSize: PAGE_SIZE,
        ...(search && { search }),
        ...(sort !== 'title' && { sort }),
        ...(genre && { genre }),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
  });

  const loaded = items.data?.pages.flatMap((p) => p.items) ?? [];
  const total = items.data?.pages[0]?.total ?? 0;
  const sentinel = useLoadMore(Boolean(items.hasNextPage) && !items.isFetchingNextPage, () => {
    void items.fetchNextPage();
  });
  const title = library ? libraryLabel(library, all) : 'Bibliotheek';

  return (
    <div className="page library-page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {items.data && (
            <p className="page-sub">
              {countLabel(total, 'titel', 'titels')}
              {genre ? ` · ${genre}` : ''}
            </p>
          )}
        </div>
        <div className="toolbar">
          <label className="field search-field">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Zoeken op titel"
              aria-label="Zoeken op titel"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <label className="field select-field">
            <span className="visually-hidden">Sorteren</span>
            <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" />
          </label>
          {(genres.data?.length ?? 0) > 0 && (
            <label className="field select-field">
              <span className="visually-hidden">Genre</span>
              <select value={genre} onChange={(e) => update({ genre: e.target.value })}>
                <option value="">Alle genres</option>
                {genres.data?.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" />
            </label>
          )}
        </div>
      </header>

      {items.isPending ? (
        <ul className="poster-grid" aria-busy="true">
          <CardSkeletons count={18} />
        </ul>
      ) : items.isError ? (
        <ErrorBox error={items.error} />
      ) : loaded.length === 0 ? (
        <div className="empty-state">
          <Icon name="search" size={40} />
          <p>
            {search
              ? `Niets gevonden voor “${search}”.`
              : genre
                ? `Geen titels in het genre ${genre}.`
                : 'Deze bibliotheek is leeg. Start een scan.'}
          </p>
        </div>
      ) : (
        <>
          <ul className="poster-grid">
            {loaded.map((item) => (
              <li key={item.id}>
                <PosterCard item={item} />
              </li>
            ))}
            {items.isFetchingNextPage && <CardSkeletons count={6} />}
          </ul>
          <div ref={sentinel} className="load-more">
            <span className="muted">
              {loaded.length} van {total}
            </span>
            {items.hasNextPage && (
              <button
                type="button"
                className="button secondary"
                onClick={() => void items.fetchNextPage()}
                disabled={items.isFetchingNextPage}
              >
                {items.isFetchingNextPage ? 'Laden…' : 'Meer laden'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
