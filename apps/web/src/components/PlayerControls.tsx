import {
  type AudioTrack,
  QUALITIES,
  type Quality,
  thumbnailAt,
  type Thumbnails,
  SKIP_BUTTON_MS,
  type SkipSettings,
} from '@cinevault/shared';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { isTv } from '../device.js';
import { channelsLabel, clockLabel, codecLabel, languageLabel } from '../format.js';
import { playQuietly, qualityLabel } from '../playback.js';
import { Icon } from './Icon.js';

/** "Automatisch overslaan" in the settings: per part, for this profile. */
const SKIP_OPTIONS: { kind: keyof SkipSettings; label: string }[] = [
  { kind: 'intro', label: 'Intro' },
  { kind: 'recap', label: 'Recap' },
  { kind: 'credits', label: 'Aftiteling (de volgende aflevering meteen)' },
  { kind: 'preview', label: 'Preview van de volgende aflevering' },
];

const HIDE_AFTER_MS = 3_000;
const SEEK_STEP = 10;
const DOUBLE_TAP_MS = 300;
const VOLUME_KEY = 'cinevault.volume';

function trackLabel(track: AudioTrack): string {
  return [
    languageLabel(track.language),
    track.title,
    codecLabel(track.codec),
    channelsLabel(track.channels),
  ]
    .filter(Boolean)
    .join(' · ');
}

function savedVolume(): { volume: number; muted: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? 'null') as {
      volume?: unknown;
      muted?: unknown;
    } | null;
    if (value && typeof value.volume === 'number' && value.volume >= 0 && value.volume <= 1) {
      return { volume: value.volume, muted: value.muted === true };
    }
  } catch {
    // Default volume.
  }
  return { volume: 1, muted: false };
}

function bufferedEnd(video: HTMLVideoElement): number {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= video.currentTime + 0.5 && ranges.end(i) >= video.currentTime) {
      return ranges.end(i);
    }
  }
  return video.currentTime;
}

type Sheet = 'none' | 'audio' | 'settings';

/** Fullscreen with Safari's prefixes; on the iPhone only the video itself can go fullscreen. */
type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitShowPlaybackTargetPicker?: () => void;
};

/**
 * The video with CineVault's own controls. The browser's controls can't be
 * used: during a remux or transcode the stream starts somewhere in the film
 * and grows as the server works, so the timeline has to come from the file.
 */
export function PlayerControls({
  video,
  videoRef,
  position,
  duration,
  offset,
  onSeek,
  title,
  subtitle,
  backTo,
  quality,
  onQuality,
  tracks,
  audioTrack,
  onAudioTrack,
  statsShown,
  onStats,
  subtitlesOn,
  subtitlePanel,
  next,
  onSkipIntro,
  skipLabel = 'Intro overslaan',
  skipKey,
  skipSettings,
  onSkipSettings,
  introEditor,
  thumbnails,
  onCast,
  children,
}: {
  video: HTMLVideoElement | null;
  videoRef: (element: HTMLVideoElement | null) => void;
  position: number;
  duration: number;
  /** Where the stream starts in the file (HLS sessions), for the buffered bar. */
  offset: number;
  onSeek: (seconds: number) => void;
  title: string;
  subtitle?: string;
  backTo: string;
  quality: Quality;
  onQuality: (quality: Quality) => void;
  tracks: AudioTrack[];
  audioTrack?: number | undefined;
  onAudioTrack: (index: number) => void;
  statsShown: boolean;
  onStats: () => void;
  /** A subtitle is being shown. */
  subtitlesOn: boolean;
  /** Choosing, shifting and finding subtitles. */
  subtitlePanel: ReactNode;
  next?: { label: string; onPlay: () => void } | undefined;
  /** While the intro plays: "Intro overslaan" (S on the keyboard); also for the credits. */
  onSkipIntro?: (() => void) | undefined;
  skipLabel?: string;
  /** "Intro automatisch overslaan" in the settings, per device. */
  /** The part the button is for: it shows 8 s when that part starts, then with the controls. */
  skipKey?: string;
  /** What this profile skips by itself, and changing it. */
  skipSettings?: SkipSettings | undefined;
  onSkipSettings?: (change: Partial<SkipSettings>) => void;
  /** Admins: where the intro is, in the settings. */
  introEditor?: ReactNode;
  /** Pictures on the timeline while hovering or dragging, once the server made them. */
  thumbnails?: Thumbnails | undefined;
  /** Chrome with a Chromecast on the network: the cast button. */
  onCast?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  // The timeline's width, to place the preview while dragging (no mouse position then).
  const [timelineWidth, setTimelineWidth] = useState(0);
  const timeline = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    setTimelineWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setTimelineWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Own handle on the element for changing it (props stay read-only).
  const media = useRef<HTMLVideoElement | null>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);
  // The skip button shows for 8 s when its part starts; after that only with the controls.
  const [skipExpired, setSkipExpired] = useState<string | undefined>();
  const skipFresh = Boolean(onSkipIntro) && (skipKey ?? skipLabel) !== skipExpired;
  useEffect(() => {
    if (!skipFresh) return;
    const key = skipKey ?? skipLabel;
    const timer = setTimeout(() => setSkipExpired(key), SKIP_BUTTON_MS);
    return () => clearTimeout(timer);
  }, [skipFresh, skipKey, skipLabel]);
  const attach = useCallback(
    (element: HTMLVideoElement | null) => {
      media.current = element;
      if (element) {
        const saved = savedVolume();
        element.volume = saved.volume;
        element.muted = saved.muted;
      }
      videoRef(element);
    },
    [videoRef],
  );
  const [paused, setPaused] = useState(true);
  const [waiting, setWaiting] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [buffered, setBuffered] = useState(0);
  const [visible, setVisible] = useState(true);
  const [sheet, setSheet] = useState<Sheet>('none');
  const [fullscreen, setFullscreen] = useState(false);
  const [scrub, setScrub] = useState<number>();
  const [hover, setHover] = useState<{ x: number; time: number }>();
  const [ripple, setRipple] = useState<{ side: 'left' | 'right'; key: number }>();
  const [airplay, setAirplay] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTap = useRef<{ time: number; side: 'left' | 'right' } | undefined>(undefined);

  useEffect(() => {
    if (!video) return;
    const sync = () => {
      setPaused(video.paused);
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onVolume = () => {
      sync();
      try {
        localStorage.setItem(
          VOLUME_KEY,
          JSON.stringify({ volume: video.volume, muted: video.muted }),
        );
      } catch {
        // Not remembered.
      }
    };
    const onWaiting = () => setWaiting(true);
    const onReady = () => setWaiting(false);
    const onProgress = () => setBuffered(bufferedEnd(video));
    sync();
    const events = ['play', 'pause', 'loadedmetadata'];
    for (const name of events) video.addEventListener(name, sync);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('loadstart', onWaiting);
    video.addEventListener('playing', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('seeked', onReady);
    video.addEventListener('progress', onProgress);
    video.addEventListener('timeupdate', onProgress);
    // Safari: AirPlay to an Apple TV.
    const onTargets = (event: Event) =>
      setAirplay((event as Event & { availability?: string }).availability === 'available');
    video.addEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
    return () => {
      for (const name of events) video.removeEventListener(name, sync);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('loadstart', onWaiting);
      video.removeEventListener('playing', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('seeked', onReady);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('timeupdate', onProgress);
      video.removeEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
    };
  }, [video]);

  // The player starts with the focus, so the keys of a remote work at once.
  useEffect(() => {
    stage.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      clearTimeout(scrubTimer.current);
      clearTimeout(tapTimer.current);
    },
    [],
  );

  const wake = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (media.current && !media.current.paused) setVisible(false);
    }, HIDE_AFTER_MS);
  }, []);

  // Paused, or a sheet open: the controls stay.
  const shown = visible || paused || sheet !== 'none';
  const skipShown = Boolean(onSkipIntro) && (skipFresh || shown);
  // On a TV the button takes the remote's focus when it appears, so OK skips.
  useEffect(() => {
    if (skipShown && skipFresh && isTv()) skipButton.current?.focus();
  }, [skipShown, skipFresh]);

  function togglePlay() {
    const element = media.current;
    if (!element) return;
    if (element.paused) playQuietly(element);
    else element.pause();
  }

  function toggleMute() {
    if (media.current) media.current.muted = !media.current.muted;
  }

  function changeVolume(value: number) {
    const element = media.current;
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, value));
    element.muted = element.volume === 0;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    const container = stage.current;
    if (container?.requestFullscreen) {
      void container
        .requestFullscreen({ navigationUI: 'hide' })
        .then(() => {
          // Phones: turn to landscape, where the browser allows it.
          const orientation = screen.orientation as ScreenOrientation & {
            lock?: (o: string) => Promise<void>;
          };
          return orientation.lock?.('landscape');
        })
        .catch(() => {});
      return;
    }
    // iPhone: only the video element itself goes fullscreen (with Apple's controls).
    (media.current as WebkitVideo | null)?.webkitEnterFullscreen?.();
  }

  async function togglePip() {
    const element = media.current;
    if (!element) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await element.requestPictureInPicture();
    } catch {
      // Not allowed right now (e.g. before the video plays).
    }
  }

  function seekBy(seconds: number) {
    onSeek(position + seconds);
    wake();
  }

  /** Dragging the slider previews the time; the seek follows when it rests. */
  function scrubTo(seconds: number) {
    setScrub(seconds);
    clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => {
      onSeek(seconds);
      setScrub(undefined);
    }, 250);
  }

  /**
   * Touch: a tap shows or hides the controls, a double tap on the left or
   * right seeks 10 s. Mouse: a click plays or pauses, a double click goes
   * fullscreen.
   */
  function onSurfacePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse') {
      if (sheet !== 'none') {
        setSheet('none');
        return;
      }
      togglePlay();
      wake();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const side = x < rect.width / 2 ? 'left' : 'right';
    const now = Date.now();
    const previous = lastTap.current;
    if (previous && now - previous.time < DOUBLE_TAP_MS && previous.side === side) {
      clearTimeout(tapTimer.current);
      lastTap.current = { time: now, side };
      seekBy(side === 'left' ? -SEEK_STEP : SEEK_STEP);
      setRipple({ side, key: now });
      return;
    }
    lastTap.current = { time: now, side };
    clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      if (sheet !== 'none') setSheet('none');
      else if (shown && !paused) {
        clearTimeout(hideTimer.current);
        setVisible(false);
      } else wake();
    }, DOUBLE_TAP_MS);
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    const target = event.target as HTMLElement;
    const onStage = target === stage.current;
    const wasHidden = !shown;
    wake();
    if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
    if (target.tagName === 'SELECT') return;
    switch (event.key) {
      case 'Escape':
        if (sheet !== 'none') {
          event.preventDefault();
          setSheet('none');
          stage.current?.focus();
        }
        return;
      case 'MediaPlayPause':
      case 'MediaPlay':
      case 'MediaPause':
        event.preventDefault();
        if (event.key === 'MediaPlay') playQuietly(media.current as HTMLVideoElement);
        else if (event.key === 'MediaPause') media.current?.pause();
        else togglePlay();
        return;
      case 'MediaFastForward':
        event.preventDefault();
        seekBy(SEEK_STEP * 3);
        return;
      case 'MediaRewind':
        event.preventDefault();
        seekBy(-SEEK_STEP * 3);
        return;
      case 'MediaTrackNext':
        if (next) {
          event.preventDefault();
          next.onPlay();
        }
        return;
    }
    if (!onStage) return;
    // Keys on the picture itself (not on a button).
    switch (event.key) {
      case ' ':
      case 'k':
      case 'Enter':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
      case 'j':
        event.preventDefault();
        seekBy(-SEEK_STEP);
        break;
      case 'ArrowRight':
      case 'l':
        event.preventDefault();
        seekBy(SEEK_STEP);
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        event.preventDefault();
        if (isTv() || wasHidden) {
          // Remotes: up or down reaches the buttons.
          if (!wasHidden) playButton.current?.focus();
        } else {
          changeVolume((media.current?.volume ?? 1) + (event.key === 'ArrowUp' ? 0.1 : -0.1));
        }
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'm':
        toggleMute();
        break;
      case 'c':
        setSheet((s) => (s === 'audio' ? 'none' : 'audio'));
        break;
      case 's':
        onSkipIntro?.();
        break;
    }
  }

  const time = scrub ?? position;
  // Hovering (mouse) or dragging (touch, keys): the picture of that moment.
  const previewTime = hover?.time ?? scrub;
  const preview =
    thumbnails && previewTime !== undefined && duration > 0
      ? {
          thumbnails,
          time: previewTime,
          x: hover?.x ?? (previewTime / duration) * timelineWidth,
        }
      : undefined;
  const max = Math.max(1, Math.floor(duration));
  const playedShare = Math.min(1, time / max);
  const bufferedShare = Math.min(1, Math.max(playedShare, (offset + buffered) / max));
  const canPip =
    typeof document !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    document.pictureInPictureEnabled;
  const qualityName = qualityLabel[quality];

  return (
    <div
      ref={stage}
      className={`player-stage${shown ? '' : ' idle'}${paused ? ' paused' : ''}${sheet !== 'none' ? ' with-sheet' : ''}`}
      onMouseMove={wake}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      data-focus-scope="player"
    >
      <video ref={attach} className="player" playsInline autoPlay />
      <div
        className="player-surface"
        onPointerUp={onSurfacePointer}
        onDoubleClick={toggleFullscreen}
        aria-hidden="true"
      />
      {ripple && (
        <span key={ripple.key} className={`seek-ripple ${ripple.side}`} aria-hidden="true">
          <Icon name={ripple.side === 'left' ? 'replay10' : 'forward10'} />
        </span>
      )}
      {waiting && !paused && <span className="player-spinner" role="status" aria-label="Laden" />}

      <div className="player-top">
        <Link to={backTo} className="icon-button player-back" aria-label="Terug naar de titel">
          <Icon name="back" />
        </Link>
        <div className="player-heading">
          <span className="player-title">{title}</span>
          {subtitle && <span className="player-subtitle">{subtitle}</span>}
        </div>
        <span className="spacer" />
        {onCast && (
          <button
            type="button"
            className="icon-button"
            aria-label="Casten naar een Chromecast"
            onClick={onCast}
          >
            <Icon name="cast" />
          </button>
        )}
        {airplay && (
          <button
            type="button"
            className="icon-button"
            aria-label="AirPlay"
            onClick={() =>
              (media.current as WebkitVideo | null)?.webkitShowPlaybackTargetPicker?.()
            }
          >
            <Icon name="airplay" />
          </button>
        )}
        {canPip && (
          <button
            type="button"
            className="icon-button"
            aria-label="Beeld-in-beeld"
            onClick={() => void togglePip()}
          >
            <Icon name="pip" />
          </button>
        )}
      </div>

      <div className="player-center">
        <button
          type="button"
          className="icon-button center-skip"
          aria-label="10 seconden terug"
          tabIndex={-1}
          onClick={() => seekBy(-SEEK_STEP)}
        >
          <Icon name="replay10" />
        </button>
        <button
          type="button"
          className="icon-button center-play"
          aria-label={paused ? 'Afspelen' : 'Pauze'}
          tabIndex={-1}
          onClick={() => {
            togglePlay();
            wake();
          }}
        >
          <Icon name={paused ? 'play' : 'pause'} />
        </button>
        <button
          type="button"
          className="icon-button center-skip"
          aria-label="10 seconden vooruit"
          tabIndex={-1}
          onClick={() => seekBy(SEEK_STEP)}
        >
          <Icon name="forward10" />
        </button>
      </div>

      {children}

      <div className="player-controls">
        <div
          ref={timeline}
          className="timeline"
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const share = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            setHover({ x: share * rect.width, time: share * duration });
          }}
          onMouseLeave={() => setHover(undefined)}
          style={
            {
              '--played': `${playedShare * 100}%`,
              '--buffered': `${bufferedShare * 100}%`,
            } as CSSProperties
          }
        >
          <input
            type="range"
            className="seek"
            aria-label="Positie"
            aria-valuetext={`${clockLabel(time)} van ${clockLabel(duration)}`}
            min={0}
            max={max}
            step={1}
            value={Math.floor(time)}
            onChange={(event) => scrubTo(Number(event.target.value))}
          />
          {preview ? (
            <TimelinePreview
              thumbnails={preview.thumbnails}
              time={preview.time}
              x={preview.x}
              width={timelineWidth}
            />
          ) : (
            hover && (
              <span className="timeline-tip" style={{ left: hover.x }} aria-hidden="true">
                {clockLabel(hover.time)}
              </span>
            )
          )}
        </div>
        <div className="control-row">
          <button
            ref={playButton}
            type="button"
            className="icon-button"
            onClick={togglePlay}
            aria-label={paused ? 'Afspelen' : 'Pauze'}
          >
            <Icon name={paused ? 'play' : 'pause'} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => seekBy(-SEEK_STEP)}
            aria-label="10 seconden terug"
          >
            <Icon name="replay10" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => seekBy(SEEK_STEP)}
            aria-label="10 seconden vooruit"
          >
            <Icon name="forward10" />
          </button>
          <div className="volume-group">
            <button
              type="button"
              className="icon-button"
              onClick={toggleMute}
              aria-label={muted ? 'Geluid aan' : 'Geluid uit'}
            >
              <Icon name={muted || volume === 0 ? 'muted' : 'volume'} />
            </button>
            <input
              type="range"
              className="volume"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              style={{ '--level': `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
              onChange={(event) => changeVolume(Number(event.target.value))}
            />
          </div>
          <span className="time" aria-label="Tijd">
            {clockLabel(time)} / {clockLabel(duration)}
          </span>
          <span className="spacer" />
          {next && (
            <button type="button" className="pill-button" onClick={next.onPlay} title={next.label}>
              <Icon name="next" />
              <span>Volgende aflevering</span>
            </button>
          )}
          <button
            type="button"
            className={`icon-button${subtitlesOn ? ' active' : ''}`}
            aria-label="Audio en ondertitels"
            aria-expanded={sheet === 'audio'}
            onClick={() => setSheet((s) => (s === 'audio' ? 'none' : 'audio'))}
          >
            <Icon name="subtitles" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Instellingen (kwaliteit ${qualityName})`}
            aria-expanded={sheet === 'settings'}
            onClick={() => setSheet((s) => (s === 'settings' ? 'none' : 'settings'))}
          >
            <Icon name="settings" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Volledig scherm uit' : 'Volledig scherm'}
          >
            <Icon name={fullscreen ? 'exitFullscreen' : 'fullscreen'} />
          </button>
        </div>
      </div>

      {onSkipIntro && skipShown && (
        <button
          ref={skipButton}
          type="button"
          className="skip-intro"
          onClick={() => {
            onSkipIntro();
            stage.current?.focus();
          }}
        >
          {skipLabel}
          <Icon name="next" />
        </button>
      )}

      {sheet !== 'none' && (
        <div
          className="player-sheet"
          role="dialog"
          aria-label={sheet === 'audio' ? 'Audio en ondertitels' : 'Instellingen'}
          data-focus-scope="modal"
        >
          <header className="sheet-head">
            <h2>{sheet === 'audio' ? 'Audio en ondertitels' : 'Instellingen'}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Sluiten"
              onClick={() => {
                setSheet('none');
                stage.current?.focus();
              }}
            >
              <Icon name="close" />
            </button>
          </header>
          {sheet === 'audio' ? (
            <div className="sheet-columns">
              <fieldset className="choice-list">
                <legend>Audio</legend>
                {tracks.length === 0 && <p className="muted">Geen geluid in dit bestand.</p>}
                {tracks.map((track) => (
                  <label key={track.index} className="choice">
                    <input
                      type="radio"
                      name="audio"
                      checked={audioTrack === track.index}
                      onChange={() => onAudioTrack(track.index)}
                    />
                    {trackLabel(track)}
                  </label>
                ))}
              </fieldset>
              {subtitlePanel}
            </div>
          ) : (
            <div className="sheet-columns">
              <fieldset className="choice-list">
                <legend>Kwaliteit</legend>
                {QUALITIES.map((q) => (
                  <label key={q.id} className="choice">
                    <input
                      type="radio"
                      name="quality"
                      checked={quality === q.id}
                      onChange={() => onQuality(q.id)}
                    />
                    {qualityLabel[q.id]}
                    {q.id === 'original' && (
                      <span className="choice-note">zoals het bestand is</span>
                    )}
                  </label>
                ))}
              </fieldset>
              <div className="choice-list">
                <p className="legend">Weergave</p>
                <button
                  type="button"
                  className="button secondary"
                  aria-pressed={statsShown}
                  onClick={onStats}
                >
                  Statistieken
                </button>
              </div>
              {skipSettings && onSkipSettings && (
                <fieldset className="choice-list">
                  <legend className="legend">Automatisch overslaan</legend>
                  {SKIP_OPTIONS.map(({ kind, label }) => (
                    <label key={kind} className="choice">
                      <input
                        type="checkbox"
                        checked={skipSettings[kind]}
                        onChange={(event) => onSkipSettings({ [kind]: event.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                  <p className="muted small">Voor dit profiel, op elk apparaat.</p>
                </fieldset>
              )}
              <div className="choice-list">
                <p className="muted small">
                  Toetsen: spatie afspelen of pauze, ← → 10 seconden, F volledig scherm, M geluid, C
                  ondertitels, S intro, recap, aftiteling of preview overslaan.
                </p>
              </div>
              {introEditor}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Width of the picture on screen: larger on a TV, smaller on a phone. */
function previewWidth(): number {
  if (isTv()) return 320;
  return window.innerWidth < 760 ? 160 : 224;
}

/** A picture of the moment above the timeline, with its time under it. */
function TimelinePreview({
  thumbnails,
  time,
  x,
  width,
}: {
  thumbnails: Thumbnails;
  time: number;
  x: number;
  /** Width of the timeline, to keep the picture inside it. */
  width: number;
}) {
  const place = thumbnailAt(thumbnails, time);
  const shown = previewWidth();
  const scale = shown / thumbnails.width;
  const height = Math.round(thumbnails.height * scale);
  const left = width > shown ? Math.min(width - shown / 2, Math.max(shown / 2, x)) : x;
  return (
    <span className="timeline-preview" style={{ left, width: shown }} aria-hidden="true">
      {place && (
        <span
          className="timeline-preview-picture"
          style={{
            height,
            backgroundImage: `url("${place.sheet}")`,
            backgroundSize: `${thumbnails.columns * shown}px ${thumbnails.rows * height}px`,
            backgroundPosition: `${-place.x * scale}px ${-place.y * scale}px`,
          }}
        />
      )}
      <span className="timeline-preview-time">{clockLabel(time)}</span>
    </span>
  );
}
