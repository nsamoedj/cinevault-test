import type { DiscoverItem, DiscoverPage as Page } from '@cinevault/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type FormEvent, useCallback, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { CardSkeletons } from '../components/cards.js';
import { ErrorBox } from '../components/common.js';
import { DiscoverCard, DiscoverDialog, DiscoverTabs } from '../components/discover.js';
import { Icon } from '../components/Icon.js';
import { Rail } from '../components/Rail.js';
import { useLoadMore } from './LibraryPage.js';

/** "movie-123" as a title to load; anything else is nothing. */
function fromKey(key: string): DiscoverItem | undefined {
  const match = /^(movie|show)-(\d+)$/.exec(key);
  if (!match) return undefined;
  return {
    kind: match[1] as DiscoverItem['kind'],
    tmdbId: Number(match[2]),
    title: '',
    anime: false,
  };
}

/** The title whose details are open, kept in the address (?title=movie-123) for Back. */
function useOpenTitle(items: DiscoverItem[]) {
  const [params, setParams] = useSearchParams();
  const [chosen, setChosen] = useState<DiscoverItem>();
  const key = params.get('title');
  const keyOf = (item: DiscoverItem) => `${item.kind}-${item.tmdbId}`;
  // Closed when the address has no title (Back). After a reload, or from a link
  // (a film of a collection), found among what is shown, else by its id: the
  // dialog loads the rest.
  const open = key
    ? chosen && keyOf(chosen) === key
      ? chosen
      : (items.find((i) => keyOf(i) === key) ?? fromKey(key))
    : undefined;
  const show = (item: DiscoverItem) => {
    setChosen(item);
    const next = new URLSearchParams(params);
    next.set('title', keyOf(item));
    setParams(next);
  };
  const close = useCallback(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('title');
        return next;
      },
      { replace: true },
    );
  }, [setParams]);
  return { open, show, close };
}

/** A grid of titles that loads more at the end: a search or one row. */
function BrowseGrid({
  queryKey,
  load,
  onOpen,
}: {
  queryKey: unknown[];
  load: (page: number) => Promise<Page>;
  onOpen: (item: DiscoverItem) => void;
}) {
  const pages = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => load(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const sentinel = useLoadMore(Boolean(pages.hasNextPage) && !pages.isFetchingNextPage, () => {
    void pages.fetchNextPage();
  });
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  if (pages.isError) return <ErrorBox error={pages.error} />;
  if (pages.isPending) {
    return (
      <ul className="poster-grid" aria-busy="true">
        <CardSkeletons count={12} />
      </ul>
    );
  }
  if (items.length === 0) return <p className="muted">Niets gevonden bij TMDB.</p>;
  return (
    <>
      <h2 className="results-title">{pages.data.pages[0]?.title}</h2>
      <ul className="poster-grid">
        {items.map((item) => (
          <li key={`${item.kind}-${item.tmdbId}`}>
            <DiscoverCard item={item} onOpen={() => onOpen(item)} />
          </li>
        ))}
      </ul>
      {pages.hasNextPage && (
        <div ref={sentinel} className="load-more">
          <button
            type="button"
            className="button glass"
            onClick={() => void pages.fetchNextPage()}
            disabled={pages.isFetchingNextPage}
          >
            Meer laden
          </button>
        </div>
      )}
    </>
  );
}

function SearchField() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [input, setInput] = useState(query);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    setParams(value ? { q: value } : {});
  };
  return (
    <form className="discover-search" role="search" onSubmit={submit}>
      <label className="search-hero">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Zoek een film of serie bij TMDB"
          aria-label="Zoeken bij TMDB"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (!e.target.value) setParams({});
          }}
        />
      </label>
    </form>
  );
}

/** "Ontdekken": the newest releases to browse and ask for, with a search. */
export function DiscoverPage() {
  const [params] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';
  const feed = useQuery({ queryKey: ['discover', 'feed'], queryFn: api.discover });
  const all = feed.data?.rows.flatMap((r) => r.items) ?? [];
  const { open, show, close } = useOpenTitle(all);

  return (
    <div className="page discover-page">
      <header className="page-head">
        <div>
          <h1>Ontdekken</h1>
          <p className="muted">
            Wat er nieuw is. Staat het er nog niet, vraag het dan aan: na goedkeuring zoekt Radarr
            of Sonarr het, en je krijgt een melding als het klaarstaat.
          </p>
        </div>
      </header>
      <DiscoverTabs />
      <SearchField />
      {query ? (
        <BrowseGrid
          queryKey={['discover', 'search', query]}
          load={(page) => api.discoverSearch(query, page)}
          onOpen={show}
        />
      ) : feed.isError ? (
        <ErrorBox error={feed.error} />
      ) : feed.isPending ? (
        <div className="rows">
          <section className="rail poster" aria-busy="true">
            <div className="rail-viewport">
              <ul className="rail-track">
                <CardSkeletons />
              </ul>
            </div>
          </section>
        </div>
      ) : (
        <div className="rows">
          {feed.data.rows.map((row) => (
            <Rail key={row.id} title={row.title} more={`/discover/rows/${row.id}`}>
              {row.items.map((item) => (
                <li key={`${item.kind}-${item.tmdbId}`}>
                  <DiscoverCard item={item} onOpen={() => show(item)} />
                </li>
              ))}
            </Rail>
          ))}
        </div>
      )}
      {open && (
        <DiscoverDialog
          key={`${open.kind}-${open.tmdbId}`}
          item={open}
          onClose={close}
          onOpen={show}
        />
      )}
    </div>
  );
}

/** One row of "Ontdekken", page by page. */
export function DiscoverRowPage() {
  const { id = '' } = useParams();
  const { open, show, close } = useOpenTitle([]);
  return (
    <div className="page discover-page">
      <DiscoverTabs />
      <BrowseGrid
        queryKey={['discover', 'row', id]}
        load={(page) => api.discoverRow(id, page)}
        onOpen={show}
      />
      {open && (
        <DiscoverDialog
          key={`${open.kind}-${open.tmdbId}`}
          item={open}
          onClose={close}
          onOpen={show}
        />
      )}
    </div>
  );
}
