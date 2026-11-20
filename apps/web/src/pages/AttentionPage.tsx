import type { ItemSummary, LibrarySummary } from '@cinevault/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, keys } from '../api.js';
import { ErrorBox, Loading, Poster } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { MatchPanel } from '../components/MatchPanel.js';
import { AdminFrame } from './AdminPage.js';

const STATUSES = ['UNMATCHED', 'FAILED'] as const;

function Row({ item, library }: { item: ItemSummary; library: LibrarySummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="attention-row">
      <div className="attention-head">
        <Poster url={item.posterUrl} title={item.title} className="attention-poster" compact />
        <div>
          <Link to={`/items/${item.id}`}>
            <strong>{item.title}</strong>
            {item.year && <span className="muted"> ({item.year})</span>}
          </Link>
          <p className="muted small">
            {library.name} ·{' '}
            {item.metadataStatus === 'FAILED' ? 'ophalen mislukt' : 'niet gematcht'}
            {item.metadataError ? ` · ${item.metadataError}` : ''}
          </p>
        </div>
        <button type="button" className="button secondary" onClick={() => setOpen((o) => !o)}>
          {open ? 'Sluiten' : 'Match zoeken'}
        </button>
      </div>
      {open && <MatchPanel item={item} onDone={() => setOpen(false)} />}
    </li>
  );
}

export function AttentionPage() {
  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const pairs = (libraries.data ?? []).flatMap((library) =>
    STATUSES.map((status) => ({ library, status })),
  );
  const results = useQueries({
    queries: pairs.map(({ library, status }) => ({
      queryKey: keys.attention(library.id, status),
      queryFn: () => api.items(library.id, { status, pageSize: 200 }),
    })),
  });

  if (libraries.isPending || results.some((r) => r.isPending)) {
    return (
      <AdminFrame title="Aandacht nodig">
        <Loading />
      </AdminFrame>
    );
  }
  const failed = libraries.error ?? results.find((r) => r.isError)?.error;
  if (failed) {
    return (
      <AdminFrame title="Aandacht nodig">
        <ErrorBox error={failed} />
      </AdminFrame>
    );
  }

  const rows = pairs.flatMap(({ library }, i) =>
    (results[i]?.data?.items ?? []).map((item) => ({ item, library })),
  );

  return (
    <AdminFrame title="Aandacht nodig">
      <p className="muted lead">
        Titels waarvoor geen overtuigende match is gevonden, of waarvan het ophalen mislukte.
        Mislukte titels worden bij de volgende scan vanzelf opnieuw geprobeerd.
      </p>
      {rows.length === 0 ? (
        <div className="empty-state">
          <Icon name="check" size={40} />
          <p className="ok">Alles is gematcht.</p>
        </div>
      ) : (
        <ul className="attention-list">
          {rows.map(({ item, library }) => (
            <Row key={item.id} item={item} library={library} />
          ))}
        </ul>
      )}
    </AdminFrame>
  );
}
