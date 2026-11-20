import {
  canReadAsText,
  pictureSubtitleNote,
  type SubtitleOption,
  type SubtitleSearchResult,
} from '@cinevault/shared';
import { useState } from 'react';
import { api } from '../api.js';
import { codecLabel, languageLabel } from '../format.js';
import type { SubtitleStatus } from '../subtitles/useSubtitles.js';

const STEP_MS = 500;

const SOURCE: Record<SubtitleOption['source'], string> = {
  embedded: 'in het bestand',
  external: 'los bestand',
  opensubtitles: 'OpenSubtitles',
};

export function subtitleLabel(option: SubtitleOption): string {
  return [
    option.language ? languageLabel(option.language) : 'Onbekende taal',
    option.label,
    option.forced ? 'alleen vreemde taal' : undefined,
    option.hearingImpaired ? 'voor doven en slechthorenden' : undefined,
    option.codec ? codecLabel(option.codec) : SOURCE[option.source],
  ]
    .filter(Boolean)
    .join(' · ');
}

function seconds(ms: number): string {
  const value = (ms / 1000).toLocaleString('nl-NL', { minimumFractionDigits: 1 });
  return `${ms > 0 ? '+' : ''}${value} s`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Choose, shift and find subtitles. */
export function SubtitlePanel({
  fileId,
  options,
  selected,
  onSelect,
  status,
  shiftMs,
  onShift,
  onAdded,
  onReadAsText,
  readError,
}: {
  fileId: string;
  options: SubtitleOption[];
  selected?: SubtitleOption;
  onSelect: (id: string | null) => void;
  status: SubtitleStatus;
  shiftMs: number;
  onShift: (ms: number) => void;
  onAdded: (option: SubtitleOption) => void;
  /** Read a picture subtitle (PGS) as text. */
  onReadAsText?: (option: SubtitleOption) => void;
  readError?: string;
}) {
  const [searching, setSearching] = useState(false);
  const [languages, setLanguages] = useState<string[]>(['nld', 'eng']);
  const [results, setResults] = useState<SubtitleSearchResult[]>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function search() {
    setBusy('search');
    setError(undefined);
    try {
      setResults(await api.searchSubtitles(fileId, languages));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function download(result: SubtitleSearchResult) {
    setBusy(result.id);
    setError(undefined);
    try {
      onAdded(await api.downloadSubtitle(fileId, result.id));
      setSearching(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <aside className="subtitle-panel" aria-label="Ondertitels">
      <fieldset className="choice-list">
        <legend>Ondertitels</legend>
        <label className="choice">
          <input type="radio" name="subtitle" checked={!selected} onChange={() => onSelect(null)} />
          Uit
        </label>
        {options.map((option) => {
          const note = pictureSubtitleNote(option);
          return (
            <div key={option.id} className="choice-row">
              <label className={option.supported ? 'choice' : 'choice unsupported'}>
                <input
                  type="radio"
                  name="subtitle"
                  disabled={!option.supported}
                  checked={selected?.id === option.id}
                  onChange={() => onSelect(option.id)}
                />
                {subtitleLabel(option)}
                {note && <span className="muted"> ({note})</span>}
              </label>
              {onReadAsText && canReadAsText(option) && (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => onReadAsText(option)}
                >
                  {option.ocr === 'failed' ? 'Opnieuw proberen' : 'Omzetten naar tekst'}
                </button>
              )}
            </div>
          );
        })}
      </fieldset>
      {readError && <p role="alert">Omzetten lukt niet: {readError}</p>}

      {status.kind === 'loading' && <p className="muted">Ondertitels laden…</p>}
      {status.kind === 'reading' && (
        <p className="muted">De server leest de ondertitels uit het bestand…</p>
      )}
      {status.kind === 'error' && <p role="alert">Ondertitels lukken niet: {status.message}</p>}

      {selected && (
        <div className="subtitle-shift" role="group" aria-label="Verschuiving">
          <span>Verschuiving {seconds(shiftMs)}</span>
          <button
            type="button"
            className="button secondary small"
            onClick={() => onShift(shiftMs - STEP_MS)}
          >
            −0,5 s
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => onShift(shiftMs + STEP_MS)}
          >
            +0,5 s
          </button>
          {shiftMs !== 0 && (
            <button type="button" className="text-button" onClick={() => onShift(0)}>
              Terug naar 0
            </button>
          )}
        </div>
      )}

      {searching ? (
        <div className="subtitle-search">
          <div className="languages">
            {[
              ['nld', 'Nederlands'],
              ['eng', 'Engels'],
            ].map(([code, name]) => (
              <label key={code}>
                <input
                  type="checkbox"
                  checked={languages.includes(code as string)}
                  onChange={(event) =>
                    setLanguages((current) =>
                      event.target.checked
                        ? [...current, code as string]
                        : current.filter((l) => l !== code),
                    )
                  }
                />
                {name}
              </label>
            ))}
            <button
              type="button"
              className="button secondary small"
              disabled={languages.length === 0 || busy !== undefined}
              onClick={() => void search()}
            >
              {busy === 'search' ? 'Zoeken…' : 'Zoeken'}
            </button>
          </div>
          {results && results.length === 0 && <p className="muted">Niets gevonden.</p>}
          {results && results.length > 0 && (
            <ul className="results">
              {results.slice(0, 20).map((result) => (
                <li key={result.id}>
                  <span>
                    <strong>{result.language ? languageLabel(result.language) : '?'}</strong>{' '}
                    {result.release}
                    <span className="muted">
                      {' · '}
                      {result.downloads.toLocaleString('nl-NL')} downloads
                      {result.matchesFile && ' · past bij dit bestand'}
                      {result.hearingImpaired && ' · SDH'}
                      {result.machineTranslated && ' · machinevertaling'}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy !== undefined}
                    onClick={() => void download(result)}
                  >
                    {busy === result.id ? 'Bezig…' : 'Kiezen'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button type="button" className="text-button" onClick={() => setSearching(true)}>
          Zoeken op OpenSubtitles…
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
