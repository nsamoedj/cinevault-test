import {
  airDateLabel,
  isResumable as resumable,
  isLatinScript,
  showStart,
  type EpisodeDto,
  type ItemDetails,
  type MediaFileDto,
  type ProgressDto,
  type SeasonDto,
  upcomingLabel,
} from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, keys } from '../api.js';
import { useAuth } from '../auth.js';
import { backdropSrc } from '../components/backdrop.js';
import { MissingPartCard, PosterCard, ProgressBar, WatchedBadge } from '../components/cards.js';
import { ErrorBox, Poster, TitleLogo } from '../components/common.js';
import { ageFact, DownloadLine } from '../components/Download.js';
import { FileDetails, fileSummary } from '../components/FileDetails.js';
import { qualityBadges } from '../components/Hero.js';
import { Icon } from '../components/Icon.js';
import { MatchPanel } from '../components/MatchPanel.js';
import { RemovePanel } from '../components/RemovePanel.js';
import { MyListButton } from '../components/MyListButton.js';
import { Rail } from '../components/Rail.js';
import { TrailerDialog } from '../components/Trailer.js';
import { channelsLabel, clockLabel, dateLabel, runtimeLabel, seasonLabel } from '../format.js';
import { plan, planSummary, savedQuality } from '../playback.js';
import { useThemeMusic } from '../themeMusic.js';

function SourceNote({ item }: { item: ItemDetails }) {
  if (!item.metadataProvider) return null;
  const tvmaze = item.metadataProvider.includes('tvmaze');
  const tmdb = item.metadataProvider.includes('tmdb');
  return (
    <p className="source-note">
      Gegevens: {tmdb && 'TMDB'}
      {tmdb && tvmaze && ' en '}
      {tvmaze && (
        <>
          <a
            href={
              item.ids.tvmaze
                ? `https://www.tvmaze.com/shows/${item.ids.tvmaze}`
                : 'https://www.tvmaze.com'
            }
            target="_blank"
            rel="noreferrer"
          >
            TVmaze
          </a>{' '}
          (CC BY-SA 4.0)
        </>
      )}
    </p>
  );
}

function useWatched(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { kind: 'items' | 'seasons' | 'episodes'; id: string; watched: boolean }) =>
      api.setWatched(args.kind, args.id, args.watched),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.item(itemId) });
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: keys.continue });
    },
  });
}

function WatchedButton({
  watched,
  onChange,
  label,
  compact = false,
}: {
  watched: boolean;
  onChange: (watched: boolean) => void;
  label?: string;
  /** Only the icon (episode rows); the label is for screen readers and the tooltip. */
  compact?: boolean;
}) {
  const text = watched ? 'Gezien' : (label ?? 'Markeer als gezien');
  return (
    <button
      type="button"
      className={`${compact ? 'icon-button round' : 'button glass'} watched-toggle${watched ? ' on' : ''}`}
      aria-pressed={watched}
      title={watched ? 'Gezien (klik om ongedaan te maken)' : text}
      onClick={() => onChange(!watched)}
    >
      <Icon name={watched ? 'check' : 'plus'} />
      {compact ? <span className="visually-hidden">{text}</span> : <span>{text}</span>}
    </button>
  );
}

function PlayLink({
  file,
  progress,
  label = 'Afspelen',
}: {
  file: MediaFileDto;
  progress?: ProgressDto | undefined;
  label?: string;
}) {
  const result = plan(file, { quality: savedQuality() });
  if (result.mode === 'unplayable') {
    return (
      <Link to={`/play/${file.id}`} className="button glass large" title={planSummary(result)}>
        <Icon name="alert" /> Niet af te spelen
      </Link>
    );
  }
  const resume = resumable(progress) && progress.fileId === file.id;
  return (
    <Link to={`/play/${file.id}`} className="button primary large" title={planSummary(result)}>
      <Icon name="play" />
      {resume ? `Verder kijken (${clockLabel(progress.positionMs / 1000)})` : label}
    </Link>
  );
}

/** "4K · HDR10 · 5.1": what the best file offers. */
function fileBadges(files: MediaFileDto[]): string[] {
  const best = [...files].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (!best) return [];
  const badges = qualityBadges(best.height, best.hdrFormat);
  const channels = Math.max(0, ...best.audioTracks.map((t) => t.channels ?? 0));
  if (channels >= 6) badges.push(channelsLabel(channels));
  return badges;
}

/** Admin actions behind a "…" button, out of the way of watching. */
function AdminMenu({
  item,
  onMatch,
  onRemove,
}: {
  item: ItemDetails;
  onMatch: () => void;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const firstSeason = [...(item.seasons ?? [])]
    .filter((s) => s.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
  const unmatch = useMutation({
    mutationFn: () => api.clearMatch(item.id),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.item(item.id), updated);
      void queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });
  // Shares the query with the theme music itself (themeMusic.ts).
  const theme = useQuery({
    queryKey: keys.theme(item.id),
    queryFn: () => api.theme(item.id),
    enabled: open,
    staleTime: 60_000,
  });
  const themeChoice = useMutation({
    mutationFn: (off: boolean) => api.setTheme(item.id, { off }),
    onSuccess: (next) => queryClient.setQueryData(keys.theme(item.id), next),
  });
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="admin-menu" ref={menu} data-focus-scope={open ? 'menu' : undefined}>
      <button
        type="button"
        className="icon-button round"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Meer acties"
        title="Meer acties"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onMatch();
            }}
          >
            <Icon name="search" /> Match corrigeren
          </button>
          {item.matchLocked && (
            <button
              type="button"
              role="menuitem"
              disabled={unmatch.isPending}
              onClick={() => {
                setOpen(false);
                unmatch.mutate();
              }}
            >
              <Icon name="refresh" /> Match ongedaan maken
            </button>
          )}
          {theme.data && (theme.data.off || theme.data.from) && (
            <button
              type="button"
              role="menuitem"
              disabled={themeChoice.isPending}
              onClick={() => {
                setOpen(false);
                themeChoice.mutate(!theme.data?.off);
              }}
            >
              <Icon name={theme.data.off ? 'volume' : 'muted'} />{' '}
              {theme.data.off ? 'Themamuziek aanzetten' : 'Themamuziek uitzetten'}
            </button>
          )}
          {item.type === 'SHOW' && firstSeason && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void navigate(`/admin/markers/${firstSeason.id}`)}
            >
              <Icon name="next" /> Intro, recap en aftiteling per aflevering
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            <Icon name="trash" /> {item.type === 'SHOW' ? 'Serie verwijderen' : 'Film verwijderen'}…
          </button>
        </div>
      )}
      {unmatch.isError && <ErrorBox error={unmatch.error} />}
      {themeChoice.isError && <ErrorBox error={themeChoice.error} />}
    </div>
  );
}

function EpisodeRow({
  episode,
  onWatched,
}: {
  episode: EpisodeDto;
  onWatched: (watched: boolean) => void;
}) {
  const file = episode.files[0];
  const progress = episode.progress;
  const watched = progress?.watched ?? false;
  const share =
    progress && !watched && progress.durationMs ? progress.positionMs / progress.durationMs : 0;
  const title = episode.title ?? `Aflevering ${episode.episodeNumber}`;
  const meta = [runtimeLabel(episode.runtimeMinutes), dateLabel(episode.airDate)].filter(Boolean);
  const still = (
    <span className="episode-still">
      {episode.stillUrl ? (
        <img src={episode.stillUrl} alt="" loading="lazy" />
      ) : (
        <span className="poster-placeholder">
          <span>{episode.episodeNumber}</span>
        </span>
      )}
      {file && (
        <span className="card-play" aria-hidden="true">
          <Icon name="play" />
        </span>
      )}
      {share > 0 && <ProgressBar share={share} />}
      {watched && <WatchedBadge />}
    </span>
  );
  return (
    <li className={`episode${watched ? ' watched' : ''}`}>
      {file ? (
        <Link
          to={`/play/${file.id}`}
          className="episode-main"
          aria-label={`Aflevering ${episode.episodeNumber}: ${title}, afspelen`}
          title={fileSummary(file)}
        >
          {still}
          <span className="episode-text">
            <span className="episode-heading">
              <span className="episode-number">{episode.episodeNumber}</span>
              <span className="episode-title">{title}</span>
            </span>
            {meta.length > 0 && <span className="episode-meta">{meta.join(' · ')}</span>}
            {episode.overview && <span className="episode-overview">{episode.overview}</span>}
          </span>
        </Link>
      ) : (
        <div className="episode-main missing">
          {still}
          <span className="episode-text">
            <span className="episode-heading">
              <span className="episode-number">{episode.episodeNumber}</span>
              <span className="episode-title">{title}</span>
            </span>
            <span className="episode-meta">Geen bestand</span>
          </span>
        </div>
      )}
      <WatchedButton compact watched={watched} onChange={onWatched} />
    </li>
  );
}

function Seasons({ item }: { item: ItemDetails }) {
  const watched = useWatched(item.id);
  // Regular seasons first; specials last.
  const ordered = [...item.seasons].sort(
    (a, b) => (a.seasonNumber || 1000) - (b.seasonNumber || 1000),
  );
  // The season the profile is in, else the first.
  const current = ordered.find((s) => s.episodes.some((e) => e.progress && !e.progress.watched));
  const [selected, setSelected] = useState(current?.id ?? ordered[0]?.id);
  const season: SeasonDto | undefined = ordered.find((s) => s.id === selected) ?? ordered[0];
  if (!season) return <p className="muted">Geen afleveringen gevonden.</p>;
  const allWatched =
    season.episodes.length > 0 && season.episodes.every((e) => e.progress?.watched);

  return (
    <section className="seasons" aria-labelledby="episodes-heading">
      <header className="section-head">
        <h2 id="episodes-heading">Afleveringen</h2>
        <div className="section-tools">
          {ordered.length > 1 && (
            <label className="field select-field">
              <span className="visually-hidden">Seizoen</span>
              <select value={season.id} onChange={(e) => setSelected(e.target.value)}>
                {ordered.map((s) => (
                  <option key={s.id} value={s.id}>
                    {seasonLabel(s.seasonNumber)} ({s.episodes.length})
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" />
            </label>
          )}
          <WatchedButton
            watched={allWatched}
            label="Seizoen als gezien markeren"
            onChange={(value) => watched.mutate({ kind: 'seasons', id: season.id, watched: value })}
          />
        </div>
      </header>
      {ordered.length === 1 && <p className="season-name">{seasonLabel(season.seasonNumber)}</p>}
      {season.overview && <p className="season-overview">{season.overview}</p>}
      <ol className="episodes">
        {season.episodes.map((episode) => (
          <EpisodeRow
            key={episode.id}
            episode={episode}
            onWatched={(value) =>
              watched.mutate({ kind: 'episodes', id: episode.id, watched: value })
            }
          />
        ))}
      </ol>
    </section>
  );
}

/** A film's collection: its films in order, with a link to the collection. */
function CollectionRail({ collection }: { collection: { id: number; name: string } }) {
  const { isKid } = useAuth();
  const details = useQuery({
    queryKey: keys.collection(collection.id),
    queryFn: () => api.collection(collection.id),
  });
  if (!details.data || details.data.parts.length < 2) return null;
  return (
    <Rail title={details.data.name} more={`/collections/${collection.id}`}>
      {details.data.parts.map((part) => (
        <li key={part.tmdbId}>
          {part.item ? (
            <PosterCard item={part.item} />
          ) : (
            <MissingPartCard part={part} canAsk={!isKid} />
          )}
        </li>
      ))}
    </Rail>
  );
}

/** "Meer zoals dit": TMDB's recommendations that are in the library, then the same genres. */
function SimilarRail({ itemId }: { itemId: string }) {
  const similar = useQuery({ queryKey: keys.similar(itemId), queryFn: () => api.similar(itemId) });
  if (!similar.data || similar.data.length === 0) return null;
  return (
    <Rail title="Meer zoals dit">
      {similar.data.map((item) => (
        <li key={item.id}>
          <PosterCard item={item} />
        </li>
      ))}
    </Rail>
  );
}

export function ItemPage() {
  const { id = '' } = useParams();
  const [matching, setMatching] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [trailer, setTrailer] = useState(false);
  const closeTrailer = useCallback(() => setTrailer(false), []);
  const { isAdmin } = useAuth();
  const watched = useWatched(id);
  const item = useQuery({
    queryKey: keys.item(id),
    queryFn: () => api.item(id),
    // While Radarr or Sonarr downloads it, the bar moves.
    refetchInterval: (query) => (query.state.data?.download ? 15_000 : false),
  });
  const music = useThemeMusic(id, {
    enabled: Boolean(item.data),
    active: !trailer && !removing,
  });

  if (item.isPending) {
    return (
      <div className="detail" aria-busy="true">
        <div className="detail-hero skeleton" />
      </div>
    );
  }
  if (item.isError) {
    return (
      <div className="page">
        <ErrorBox error={item.error} />
      </div>
    );
  }
  const data = item.data;
  const isShow = data.type === 'SHOW';
  const episodeFiles = data.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files));
  const badges = fileBadges(isShow ? episodeFiles : data.files);
  const seasonCount = data.seasons.filter((s) => s.seasonNumber > 0).length;
  const facts = [
    data.year,
    ageFact(data.ageRating),
    isShow
      ? seasonCount > 0
        ? `${seasonCount} ${seasonCount === 1 ? 'seizoen' : 'seizoenen'}`
        : ''
      : runtimeLabel(data.runtimeMinutes),
    isShow && data.status ? data.status : '',
  ].filter(Boolean);
  const start = isShow ? showStart(data) : undefined;
  const startFile = start?.episode.files[0];

  return (
    <article className="detail">
      <div className="detail-hero">
        {data.backdropUrl && (
          <img
            className="detail-backdrop"
            src={backdropSrc(data.backdropUrl)}
            alt=""
            fetchPriority="high"
          />
        )}
        <div className="detail-hero-content">
          <Poster url={data.posterUrl} title={data.title} className="detail-poster" />
          <div className="detail-info">
            <h1 className={data.logoUrl ? 'has-logo' : undefined}>
              <TitleLogo key={data.logoUrl} url={data.logoUrl} title={data.title} />
            </h1>
            {/* Titles are shown in English; an original title in another script is left out. */}
            {data.originalTitle && isLatinScript(data.originalTitle) && (
              <p className="original-title">{data.originalTitle}</p>
            )}
            <p className="meta-line">
              {data.rating ? (
                <span className="rating">
                  <Icon name="star" />{' '}
                  {data.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}
                </span>
              ) : null}
              {facts.map((fact) => (
                <span key={String(fact)}>{fact}</span>
              ))}
              {badges.map((badge) => (
                <span key={badge} className="badge">
                  {badge}
                </span>
              ))}
            </p>
            {data.genres.length > 0 && <p className="genres">{data.genres.join(' · ')}</p>}
            {data.download && <DownloadLine download={data.download} large />}
            {data.nextEpisode && (
              <p className="next-air">
                <Icon name="calendar" />
                <span>
                  Nieuwe aflevering <strong>{airDateLabel(data.nextEpisode.airDate)}</strong>:{' '}
                  {upcomingLabel(data.nextEpisode)}
                </span>
              </p>
            )}

            <div className="detail-actions">
              {isShow
                ? startFile &&
                  start && (
                    <PlayLink
                      file={startFile}
                      progress={start.episode.progress}
                      label={
                        start.season.seasonNumber === 1 && start.episode.episodeNumber === 1
                          ? 'Afspelen'
                          : `Afspelen S${start.season.seasonNumber}:A${start.episode.episodeNumber}`
                      }
                    />
                  )
                : data.files.map((file, i) => (
                    <PlayLink
                      key={file.id}
                      file={file}
                      progress={data.resume}
                      label={data.files.length > 1 ? `Afspelen (${i + 1})` : 'Afspelen'}
                    />
                  ))}
              {!isShow && data.files[0] && resumable(data.resume) && (
                <Link to={`/play/${data.files[0].id}?start=0`} className="button glass large">
                  <Icon name="replay10" /> Vanaf het begin
                </Link>
              )}
              <MyListButton itemId={data.id} inList={data.inMyList ?? false} large />
              {data.trailerKey && (
                <button
                  type="button"
                  className="button glass large"
                  onClick={() => setTrailer(true)}
                >
                  <Icon name="film" /> Trailer
                </button>
              )}
              {music.playing && (
                <button
                  type="button"
                  className="icon-button round theme-stop"
                  aria-label="Themamuziek stoppen"
                  title="Themamuziek stoppen"
                  onClick={music.stop}
                >
                  <Icon name="volume" />
                </button>
              )}
              <WatchedButton
                watched={data.progress?.watched ?? false}
                label={isShow ? 'Alles als gezien markeren' : 'Markeer als gezien'}
                onChange={(value) => watched.mutate({ kind: 'items', id: data.id, watched: value })}
              />
              {isAdmin && (
                <AdminMenu
                  item={data}
                  onMatch={() => setMatching(true)}
                  onRemove={() => setRemoving(true)}
                />
              )}
            </div>
            {!isShow && data.resume && resumable(data.resume) && data.resume.durationMs && (
              <div className="detail-progress">
                <ProgressBar share={data.resume.positionMs / data.resume.durationMs} />
                <span>
                  nog {clockLabel((data.resume.durationMs - data.resume.positionMs) / 1000)}
                </span>
              </div>
            )}

            {data.tagline && <p className="tagline">{data.tagline}</p>}
            {data.overview && <p className="overview">{data.overview}</p>}
            {data.metadataStatus !== 'MATCHED' && (
              <p className="warning">
                <Icon name="alert" />{' '}
                {data.metadataStatus === 'FAILED' ? 'Metadata ophalen mislukt' : 'Niet gematcht'}
                {data.metadataError ? `: ${data.metadataError}` : ''}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="detail-body">
        {matching && (
          <section className="panel">
            <header className="section-head">
              <h2>Match corrigeren</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Sluiten"
                onClick={() => setMatching(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            <MatchPanel item={data} onDone={() => setMatching(false)} />
          </section>
        )}

        {removing && <RemovePanel item={data} onClose={() => setRemoving(false)} />}

        {isShow && <Seasons item={data} />}

        {data.cast.length > 0 && (
          <Rail title="Cast">
            {data.cast.map((person) => (
              <li key={`${person.name}-${person.character ?? ''}`}>
                <div className="person">
                  <Poster
                    url={person.profileUrl}
                    title={person.name}
                    className="person-photo"
                    compact
                  />
                  <strong>{person.name}</strong>
                  {person.character && <span>{person.character}</span>}
                </div>
              </li>
            ))}
          </Rail>
        )}

        {data.collection && <CollectionRail collection={data.collection} />}
        <SimilarRail itemId={data.id} />

        {data.files.length > 0 && (
          <section className="file-section" aria-labelledby="file-heading">
            <h2 id="file-heading">Bestand</h2>
            {data.files.map((file) => (
              <div key={file.id} className="movie-file">
                <p className="muted">{fileSummary(file)}</p>
                <FileDetails file={file} />
              </div>
            ))}
          </section>
        )}
        <SourceNote item={data} />
      </div>
      {trailer && data.trailerKey && (
        <TrailerDialog videoKey={data.trailerKey} title={data.title} onClose={closeTrailer} />
      )}
    </article>
  );
}
