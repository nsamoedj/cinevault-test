import { type CalendarScope, calendarDayLabel, groupByDay, upcomingLabel } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, keys } from '../api.js';
import { ErrorBox, Loading } from '../components/common.js';
import { Icon } from '../components/Icon.js';

/** "Agenda": new episodes of the shows the profile follows, per day. */
export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const scope: CalendarScope = params.get('scope') === 'all' ? 'all' : 'following';
  const setScope = (next: CalendarScope) =>
    setParams(next === 'all' ? { scope: 'all' } : {}, { replace: true });
  const list = useQuery({ queryKey: keys.calendar(scope), queryFn: () => api.calendar(scope) });
  const days = groupByDay(list.data?.episodes ?? []);
  const today = list.data?.today ?? '';

  return (
    <div className="page narrow calendar-page">
      <header className="page-head">
        <div>
          <h1>Agenda</h1>
          <p className="page-sub">Wanneer de volgende afleveringen uitkomen.</p>
        </div>
        <div className="segmented" role="group" aria-label="Welke series">
          <button
            type="button"
            className="segment"
            aria-pressed={scope === 'following'}
            onClick={() => setScope('following')}
          >
            Die ik volg
          </button>
          <button
            type="button"
            className="segment"
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
          >
            Alle series
          </button>
        </div>
      </header>

      <CalendarConnect />

      {list.isError && <ErrorBox error={list.error} />}
      {list.isPending && <Loading />}
      {list.data && days.length === 0 && (
        <div className="empty-state">
          <Icon name="calendar" size={48} />
          <h2>{scope === 'following' ? 'Geen afleveringen gepland' : 'Nog niets gepland'}</h2>
          <p>
            {scope === 'following' ? (
              <>
                Je volgt een serie als hij in <strong>Mijn lijst</strong> staat, of als je er de
                laatste vier maanden een aflevering van keek. Zodra er een datum voor een nieuwe
                aflevering bekend is, staat hij hier.
              </>
            ) : (
              'Van geen enkele serie in de bibliotheek is al een datum bekend.'
            )}
          </p>
          {scope === 'following' && (
            <button type="button" className="button secondary" onClick={() => setScope('all')}>
              Alle series bekijken
            </button>
          )}
        </div>
      )}

      {days.map((day) => (
        <section
          key={day.date}
          className={`calendar-day${day.date < today ? ' past' : ''}${day.date === today ? ' today' : ''}`}
          aria-label={calendarDayLabel(day.date)}
        >
          <h2>{calendarDayLabel(day.date)}</h2>
          <ul>
            {day.entries.map((e) => {
              const image = e.item.backdropUrl ?? e.item.posterUrl;
              return (
                <li key={`${e.item.id}-${e.seasonNumber}-${e.episodeNumber}`}>
                  <Link to={`/items/${e.item.id}`} className="calendar-entry">
                    <span className="calendar-image">
                      {image ? <img src={image} alt="" loading="lazy" /> : null}
                    </span>
                    <span className="calendar-text">
                      <strong>{e.item.title}</strong>
                      <span>{upcomingLabel(e)}</span>
                      {e.overview && <span className="calendar-overview">{e.overview}</span>}
                    </span>
                    {e.available ? (
                      <span className="badge calendar-badge ok">
                        <Icon name="check" size={14} /> Staat klaar
                      </span>
                    ) : day.date < today ? (
                      <span className="badge calendar-badge">Nog niet binnen</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** "Agenda koppelen": the secret link for Google Calendar, Apple or another app. */
function CalendarConnect() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = useQuery({ queryKey: keys.calendarLink, queryFn: api.calendarLink, enabled: open });
  const reset = useMutation({
    mutationFn: api.resetCalendarLink,
    onSuccess: (data) => queryClient.setQueryData(keys.calendarLink, data),
  });

  const copy = async () => {
    if (!link.data) return;
    try {
      await navigator.clipboard.writeText(link.data.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt('Kopieer de link:', link.data.url);
    }
  };

  if (!open) {
    return (
      <div className="panel calendar-connect closed">
        <Icon name="calendar" size={28} />
        <div>
          <strong>Agenda koppelen</strong>
          <p className="muted">
            Zet deze afleveringen in Google Agenda, de agenda van je iPhone of Mac, of een andere
            agenda-app. Nieuwe datums komen er vanzelf bij.
          </p>
        </div>
        <button type="button" className="button secondary" onClick={() => setOpen(true)}>
          Koppelen
        </button>
      </div>
    );
  }

  return (
    <div className="panel calendar-connect">
      <h2>Agenda koppelen</h2>
      {link.isError && <ErrorBox error={link.error} />}
      {link.isPending && <Loading label="Link maken…" />}
      {link.data && (
        <>
          {!link.data.secure && (
            <p className="calendar-warning">
              <Icon name="alert" size={18} />
              <span>
                Deze link begint met <code>http://</code>. Google Agenda kan hem dan niet ophalen;
                open CineVault via <code>https://</code> (je domein) voor een link die overal werkt.
              </span>
            </p>
          )}
          <div className="button-row">
            <a
              className="button primary"
              href={link.data.googleUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="plus" /> Google Agenda
            </a>
            <a className="button secondary" href={link.data.webcalUrl}>
              <Icon name="calendar" /> Agenda-app (Apple, Outlook)
            </a>
            <button type="button" className="button secondary" onClick={() => void copy()}>
              <Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Gekopieerd' : 'Link kopiëren'}
            </button>
          </div>
          <ol className="calendar-steps">
            <li>
              Kies <strong>Google Agenda</strong>, of open zelf{' '}
              <a href="https://calendar.google.com" target="_blank" rel="noreferrer">
                calendar.google.com
              </a>{' '}
              en kies links bij <em>Andere agenda&apos;s</em> + → <em>Via URL</em>. Plak daar de
              link hieronder.
            </li>
            <li>
              Dat lukt alleen op een computer: de app van Google Agenda op je telefoon kan geen
              agenda via een link toevoegen. Zet daarna in die app onder <em>Instellingen</em> →{' '}
              <em>CineVault</em> het synchroniseren aan.
            </li>
          </ol>
          <input
            className="calendar-url"
            readOnly
            value={link.data.url}
            aria-label="Link van je agenda"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="muted small">
            Google Agenda ververst een gekoppelde agenda zelf, meestal een paar keer per dag. Op
            Android zonder Google Agenda werkt de app ICSx⁵. Iedereen met deze link ziet welke
            series je volgt; deel hem dus niet.{' '}
            <button
              type="button"
              className="link-button"
              disabled={reset.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Een nieuwe link maken? De oude link werkt dan niet meer; koppel de agenda daarna opnieuw.',
                  )
                ) {
                  reset.mutate();
                }
              }}
            >
              Nieuwe link maken
            </button>
          </p>
          {reset.isSuccess && <p className="ok small">Nieuwe link gemaakt.</p>}
        </>
      )}
    </div>
  );
}
