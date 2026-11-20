import type { ItemSummary, MatchCandidate } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, keys } from '../api.js';
import { ErrorBox, Loading, Poster } from './common.js';

const providerLabel = { tmdb: 'TMDB', tvmaze: 'TVmaze' } as const;

/** Search the providers and pick the right title for an item. */
export function MatchPanel({ item, onDone }: { item: ItemSummary; onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(item.title);
  const [year, setYear] = useState(item.year ? String(item.year) : '');
  const [query, setQuery] = useState<{ title: string; year?: number }>({
    title: item.title,
    ...(item.year && { year: item.year }),
  });

  const candidates = useQuery({
    queryKey: keys.candidates(item.id, query.title, query.year),
    queryFn: () => api.candidates(item.id, query),
  });

  const choose = useMutation({
    mutationFn: (candidate: MatchCandidate) =>
      api.setMatch(item.id, { provider: candidate.provider, id: candidate.id }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.item(item.id) }),
        queryClient.invalidateQueries({ queryKey: ['items'] }),
        queryClient.invalidateQueries({ queryKey: keys.libraries }),
      ]);
      onDone?.();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedYear = Number(year);
    setQuery({
      title: title.trim() || item.title,
      ...(year && parsedYear > 1800 && { year: parsedYear }),
    });
  };

  return (
    <div className="match-panel">
      <form onSubmit={submit} className="match-form">
        <label>
          Titel
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Jaar
          <input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            inputMode="numeric"
            size={6}
          />
        </label>
        <button type="submit" className="button primary">
          Zoeken
        </button>
      </form>

      {candidates.isPending ? (
        <Loading label="Zoeken…" />
      ) : candidates.isError ? (
        <ErrorBox error={candidates.error} />
      ) : candidates.data.length === 0 ? (
        <p className="muted">Geen resultaten. Probeer een andere titel of laat het jaar leeg.</p>
      ) : (
        <ul className="candidates">
          {candidates.data.map((candidate) => (
            <li key={`${candidate.provider}-${candidate.id}`}>
              <Poster
                url={candidate.posterUrl}
                title={candidate.title}
                className="candidate-poster"
                compact
              />
              <div className="candidate-text">
                <strong>
                  {candidate.title}
                  {candidate.year && <span className="muted"> ({candidate.year})</span>}
                </strong>
                {candidate.originalTitle && (
                  <span className="muted">{candidate.originalTitle}</span>
                )}
                <span className="tag">{providerLabel[candidate.provider]}</span>
                {candidate.overview && <p className="clamp">{candidate.overview}</p>}
              </div>
              <button
                type="button"
                className="button primary"
                onClick={() => choose.mutate(candidate)}
                disabled={choose.isPending}
              >
                Kiezen
              </button>
            </li>
          ))}
        </ul>
      )}
      {choose.isError && <ErrorBox error={choose.error} title="Match niet opgeslagen" />}
    </div>
  );
}
