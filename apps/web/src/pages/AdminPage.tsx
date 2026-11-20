import { healthLevelLabel, introSearchLines, timeAgoLabel } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties, ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { api, keys } from '../api.js';
import { ErrorBox } from '../components/common.js';
import { Icon } from '../components/Icon.js';
import { libraryLabel } from '../components/Layout.js';
import { codecLabel, countLabel } from '../format.js';

/** Tabs above the admin pages. */
export function AdminTabs() {
  return (
    <nav className="tabs" aria-label="Beheer">
      <NavLink to="/admin" end>
        Overzicht
      </NavLink>
      <NavLink to="/attention">Aandacht nodig</NavLink>
      <NavLink to="/accounts">Accounts</NavLink>
      <NavLink to="/admin/requests">Verzoeken</NavLink>
    </nav>
  );
}

export function AdminFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page admin-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Beheer</p>
          <h1>{title}</h1>
        </div>
      </header>
      <AdminTabs />
      {children}
    </div>
  );
}

function CountList({
  title,
  counts,
  label = codecLabel,
}: {
  title: string;
  counts: Record<string, number>;
  label?: (key: string) => string;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="count-list">
      <h3>{title}</h3>
      <ul>
        {rows.map(([key, count]) => (
          <li key={key}>
            <span className="count-label">{label(key)}</span>
            <span
              className="count-bar"
              style={{ '--share': `${(count / Math.max(total, 1)) * 100}%` } as CSSProperties}
            />
            <span className="count-value">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LibraryStats() {
  const { data } = useQuery({ queryKey: keys.codecStats, queryFn: api.codecStats });
  if (!data || data.files === 0) return null;
  return (
    <section className="panel">
      <h2>Wat zit er in je bibliotheek</h2>
      <p className="muted">
        {countLabel(data.files, 'bestand', 'bestanden')}. Browsers spelen H.264 en AAC overal af;
        HEVC alleen met hardware-ondersteuning; Dolby- en DTS-audio meestal niet. Wat niet direct
        kan, zet de server om tijdens het kijken.
      </p>
      <div className="count-grid">
        <CountList title="Video" counts={data.videoCodecs} />
        <CountList title="Audio (standaardspoor)" counts={data.defaultAudioCodecs} />
        <CountList title="Resolutie" counts={data.resolutions} label={(k) => k} />
        <CountList title="HDR" counts={data.hdr} label={(k) => k} />
      </div>
    </section>
  );
}

/** Skip Intro: how far the server is with finding the intros. */
function IntroSearch() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: keys.introStatus,
    queryFn: api.introStatus,
    refetchInterval: (query) => (query.state.data?.rush ? 5_000 : 30_000),
  });
  const rush = useMutation({
    mutationFn: (on: boolean) => (on ? api.searchAllIntros() : api.stopSearchAllIntros()),
    onSuccess: (next) => queryClient.setQueryData(keys.introStatus, next),
  });
  if (!data || (data.episodes === 0 && !data.films)) return null;
  const done =
    data.checked >= data.episodes &&
    (data.creditsChecked ?? data.episodes) >= data.episodes &&
    (data.recapChecked ?? data.episodes) >= data.episodes &&
    (data.filmsChecked ?? 0) >= (data.films ?? 0);
  return (
    <section className="panel">
      <h2>Intro, recap en aftiteling</h2>
      <p className="muted">
        De server zoekt per aflevering de intro, de recap en de aftiteling: bij AniSkip (anime), in
        de hoofdstukken van het bestand, of in het geluid dat afleveringen delen. Bij films zoekt
        hij de aftiteling in het beeld; een scène na de aftiteling wordt nooit overgeslagen. Dat
        gebeurt als niemand kijkt; wat je opent, gaat voor.
      </p>
      <p>
        Intro: {countLabel(data.checked, 'aflevering', 'afleveringen')} van {data.episodes} bekeken,
        gevonden in {data.found}.
        {data.creditsChecked !== undefined && (
          <>
            <br />
            Aftiteling: {data.creditsChecked} van {data.episodes} bekeken, gevonden in{' '}
            {data.creditsFound ?? 0}.
          </>
        )}
        {data.recapChecked !== undefined && (
          <>
            <br />
            Recap: {data.recapChecked} van {data.episodes} bekeken, gevonden in{' '}
            {data.recapFound ?? 0}.
          </>
        )}
        {data.previewChecked !== undefined && (
          <>
            <br />
            Preview van de volgende aflevering: {data.previewChecked} van {data.episodes} bekeken,
            gevonden in {data.previewFound ?? 0}.
          </>
        )}
        {data.films !== undefined && data.films > 0 && (
          <>
            <br />
            Aftiteling van films: {data.filmsChecked ?? 0} van {data.films} bekeken, gevonden in{' '}
            {data.filmsFound ?? 0}.
          </>
        )}
        {!done && !data.rush && data.waiting === 'playback' && ' Wacht tot niemand meer kijkt.'}
        {!done && data.waiting === 'transcoder' && ' Wacht op de transcoder.'}
      </p>
      {(data.uncertain ?? 0) > 0 && (
        <p className="muted small">
          {countLabel(data.uncertain ?? 0, 'deel is', 'delen zijn')} te onzeker voor de spelers
          (minder dan de helft van de afleveringen is het eens). Bekijk ze per seizoen: op de pagina
          van een serie, ⋯ → Intro, recap en aftiteling per aflevering.
        </p>
      )}
      {introSearchLines(data).map((line) => (
        <p key={line} className="muted small">
          {line}
        </p>
      ))}
      {(data.rush || !done) && (
        <div className="actions">
          <button
            type="button"
            className="button secondary"
            disabled={rush.isPending}
            onClick={() => rush.mutate(!data.rush)}
          >
            {data.rush ? 'Stoppen (weer alleen als niemand kijkt)' : 'Nu alles zoeken'}
          </button>
        </div>
      )}
      {data.rush && (
        <p className="muted small">
          De server zoekt nu alle afleveringen achter elkaar, ook als er gekeken wordt. Kijken kan
          daardoor haperen.
        </p>
      )}
      {rush.isError && <ErrorBox error={rush.error} />}
      <p className="muted small">
        Klopt een intro, recap of aftiteling niet? Pas die aan in de speler, onder Instellingen, of
        per seizoen op de pagina van de serie (⋯ → Intro, recap en aftiteling per aflevering).
      </p>
    </section>
  );
}

/** Theme music from Plex: how many shows have theme music, and what went wrong. */
function ThemeMusicStatus() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: keys.themeStatus,
    queryFn: api.themeStatus,
    refetchInterval: 30_000,
  });
  const retry = useMutation({
    mutationFn: api.retryThemes,
    onSuccess: (status) => {
      queryClient.setQueryData(keys.themeStatus, status);
      // The server asks Plex in the background, a second per show.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.themeStatus }), 15_000);
    },
  });
  if (!data) return null;
  const waiting = data.shows - data.ready - data.none - data.failed;
  return (
    <section className="panel">
      <h2>Themamuziek</h2>
      {!data.enabled ? (
        <p className="muted">
          Uitgezet (<code>PLEX_THEMES=false</code>).
        </p>
      ) : (
        <>
          <p className="muted">
            De titelmuziek van series komt van de themadienst van Plex; heeft Plex niets, dan bij
            anime de eerste opening van AnimeThemes, en anders het nummer dat ThemerrDB op YouTube
            aanwijst. Elk nummer wordt één keer opgehaald. Elke 10 minuten haalt de server er een
            aantal op.
          </p>
          <p>
            {data.ready} van {countLabel(data.shows, 'serie', 'series')} hebben themamuziek.
            {data.none > 0 && ` Geen bron heeft er een voor ${data.none}.`}
            {data.failed > 0 && ` Bij ${data.failed} ging het ophalen mis.`}
            {waiting > 0 && ` Nog te doen: ${waiting}.`}
          </p>
          {data.pausedUntil && (
            <p className="error small">
              {data.pausedSource === 'animethemes'
                ? 'AnimeThemes'
                : data.pausedSource === 'themerrdb'
                  ? 'YouTube (ThemerrDB)'
                  : 'Plex'}{' '}
              is niet bereikbaar; de server probeert het opnieuw om{' '}
              {new Date(data.pausedUntil).toLocaleTimeString('nl-NL', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </p>
          )}
          {data.lastError && (
            <p className="muted small">
              Laatste fout ({new Date(data.lastError.at).toLocaleString('nl-NL')}):{' '}
              {data.lastError.message}
            </p>
          )}
          {data.missing && data.missing.length > 0 && (
            <details className="theme-missing">
              <summary>Series zonder themamuziek ({data.missing.length})</summary>
              <p className="muted small">
                Wat elke bron antwoordde. Plex zoekt op het TVDB-nummer (404: geen theme voor dat
                nummer), AnimeThemes alleen voor anime (geen opening, of niet bij AnimeThemes),
                ThemerrDB op het TMDB-nummer (niet in ThemerrDB, of een YouTube-video die er niet
                meer is). Klopt het nummer niet (een verkeerde match), corrigeer dan de match.
              </p>
              <ul>
                {data.missing.map((show) => (
                  <li key={show.itemId}>
                    <Link to={`/items/${show.itemId}`}>
                      {show.title}
                      {show.year ? ` (${show.year})` : ''}
                    </Link>
                    {show.tvdbId && (
                      <>
                        {' · TVDB '}
                        <a
                          href={`https://thetvdb.com/dereferrer/series/${show.tvdbId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {show.tvdbId}
                        </a>
                        {' · '}
                        <a
                          href={`http://tvthemes.plexapp.com/${show.tvdbId}.mp3`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          bij Plex
                        </a>
                      </>
                    )}
                    <span className={show.none ? 'muted' : 'error'}> · {show.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="actions">
            <button
              type="button"
              className="button secondary"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <Icon name="refresh" /> Nu opnieuw proberen
            </button>
          </div>
          {retry.isError && <ErrorBox error={retry.error} />}
        </>
      )}
    </section>
  );
}

/** Disks, back-ups, the transcoder, scans, the certificate, Radarr and Sonarr. */
function HealthPanel() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: keys.health,
    queryFn: () => api.serverHealth(),
    refetchInterval: 60_000,
  });
  const again = useMutation({
    mutationFn: () => api.serverHealth(true),
    onSuccess: (report) => queryClient.setQueryData(keys.health, report),
  });
  if (error) return <ErrorBox error={error} title="Gezondheid niet op te halen" />;
  if (!data) return null;
  return (
    <section className={`panel health-panel health-${data.level}`}>
      <div className="health-head">
        <h2>Gezondheid</h2>
        <span className={`health-badge health-${data.level}`}>{healthLevelLabel[data.level]}</span>
        <button
          type="button"
          className="button secondary small"
          disabled={again.isPending}
          onClick={() => again.mutate()}
        >
          <Icon name="refresh" /> Opnieuw kijken
        </button>
      </div>
      <ul className="health-list">
        {data.checks.map((check) => (
          <li key={check.id} className={`health-${check.level}`}>
            <span className="health-dot" aria-label={healthLevelLabel[check.level]} />
            <div>
              <p className="health-label">{check.label}</p>
              <p className="small">{check.detail}</p>
              {check.level !== 'ok' && check.hint && <p className="muted small">{check.hint}</p>}
              {check.since && (
                <p className="muted small">Sinds {timeAgoLabel(check.since).toLowerCase()}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Bekeken {timeAgoLabel(data.checkedAt).toLowerCase()}. Gaat er iets mis, dan krijgen
        beheerders een melding.
      </p>
    </section>
  );
}

/** Scanning, the libraries and what is in them. */
export function AdminPage() {
  const queryClient = useQueryClient();
  const libraries = useQuery({ queryKey: keys.libraries, queryFn: api.libraries });
  const scan = useQuery({
    queryKey: keys.scan,
    queryFn: api.scanStatus,
    refetchInterval: (query) => (query.state.data?.running ? 2_000 : 15_000),
  });
  const startScan = useMutation({
    mutationFn: (refreshMetadata: boolean) => api.startScan({ refreshMetadata }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.scan }),
  });
  const running = scan.data?.running ?? false;
  const all = libraries.data ?? [];

  return (
    <AdminFrame title="Overzicht">
      <HealthPanel />
      <section className="panel scan-panel">
        <div>
          <h2>Bibliotheek scannen</h2>
          <p className="muted">
            {running
              ? `Bezig${scan.data?.libraryName ? ` met ${scan.data.libraryName}` : ''}: ${scan.data?.itemsMatched ?? 0} gematcht, ${scan.data?.itemsUnmatched ?? 0} niet gematcht.`
              : 'Zoekt nieuwe en verdwenen bestanden en haalt de metadata op. Ongewijzigde bestanden worden overgeslagen.'}
          </p>
          {scan.data?.errors && scan.data.errors.length > 0 && (
            <ul className="scan-errors">
              {scan.data.errors.slice(0, 5).map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="button primary"
            onClick={() => startScan.mutate(false)}
            disabled={running || startScan.isPending}
          >
            <Icon name="refresh" /> {running ? 'Scan bezig…' : 'Scannen'}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => startScan.mutate(true)}
            disabled={running || startScan.isPending}
            title="Haalt de metadata van alle titels opnieuw op"
          >
            Alles vernieuwen
          </button>
        </div>
      </section>
      {startScan.isError && <ErrorBox error={startScan.error} title="Scan niet gestart" />}

      {libraries.isError ? (
        <ErrorBox error={libraries.error} />
      ) : all.length === 0 ? (
        <p className="muted">
          Nog geen bibliotheken. Controleer of <code>MEDIA_ROOT</code> de mappen Movies, Series en
          Anime bevat en start de server opnieuw.
        </p>
      ) : (
        <ul className="library-grid">
          {all.map((library) => (
            <li key={library.id}>
              <Link to={`/libraries/${library.id}`} className="library-card">
                <span className="library-type">{libraryLabel(library, all)}</span>
                <span className="library-name">{library.name}</span>
                <span className="library-count">
                  {countLabel(library.itemCount, 'titel', 'titels')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <LibraryStats />
      <IntroSearch />
      <ThemeMusicStatus />
    </AdminFrame>
  );
}
