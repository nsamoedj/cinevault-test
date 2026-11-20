import {
  autoSkip,
  chooseAudioTrack,
  type AudioTrack,
  type FileContext,
  inCredits,
  languageCode,
  type PlaybackSession,
  type Quality,
  type SkipSettings,
  type TrackChoiceUpdate,
  skipChoice,
} from '@cinevault/shared';
import type Hls from 'hls.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** autoSkip in render: what was skipped already is checked in the effect (a ref). */
const NOTHING_SKIPPED: ReadonlySet<string> = new Set();
import { Link, useNavigate } from 'react-router';
import { Icon } from './Icon.js';
import { useQuery } from '@tanstack/react-query';
import { api, keys } from '../api.js';
import { clockLabel } from '../format.js';
import {
  nativeHls,
  plan as planFor,
  planSummary,
  playQuietly,
  forgetDeviceAutoSkip,
  savedQuality,
  saveQuality,
} from '../playback.js';
import { resumePoint, useProgressReporter } from '../playbackProgress.js';
import { PlaybackStats } from './PlaybackStats.js';
import { useSubtitles } from '../subtitles/useSubtitles.js';
import { PlayerControls } from './PlayerControls.js';
import { IntroEditor, useIntro } from './SkipIntro.js';
import { NextEpisode } from './NextEpisode.js';
import { CastView } from './CastView.js';
import { startCasting, useCast } from '../cast.js';
import { useAuth } from '../auth.js';
import { SubtitlePanel } from './SubtitlePanel.js';

/** Seeks this far behind the position stay in the stream (the transcoder keeps 10 min). */
const BACK_WINDOW = 300;
/** Seeks up to this far beyond what the server has made wait for it instead of restarting (hls.js). */
const AHEAD_WINDOW = 10;
/** Media Source Extensions buffers hold about this much (Chrome's limit is ~150 MB). */
const BUFFER_BYTES = 120_000_000;
const HEARTBEAT_MS = 20_000;
/**
 * Paused this long, an HLS stream lets its session go: the transcoder would
 * otherwise write the rest of the film to disk (and keep a transcode slot).
 * Playing again starts a new session at the same spot.
 */
const PARK_MS = 10 * 60_000;
/** How long "Verder vanaf …" stays up. */
const RESUME_NOTICE_MS = 10_000;

interface Source {
  /** Where this stream starts in the file, in seconds. */
  start: number;
  /** Bumped to start a new stream (seek far away, retry). */
  token: number;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'queued'; position?: number }
  | { kind: 'playing' }
  | { kind: 'error'; message: string };

function seekableEnd(video: HTMLVideoElement): number {
  const ranges = video.seekable;
  return ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How an HLS stream is played: the browser's own player (Safari) or hls.js. */
type Engine = 'native' | 'hls.js';

/** Seconds of video to buffer with hls.js: 30, fewer for 4K remuxes so they fit. */
function bufferSeconds(bitrate: number | undefined): number {
  if (!bitrate) return 30;
  return Math.min(30, Math.max(8, Math.floor((BUFFER_BYTES * 8) / bitrate)));
}

export function Player({
  context,
  backTo,
  fromStart = false,
}: {
  context: FileContext;
  backTo: string;
  /** "Vanaf het begin": ignore where the profile stopped. */
  fromStart?: boolean;
}) {
  const { file, item, episode, next } = context;
  const navigate = useNavigate();
  const title = item.title;
  const episodeLine = episode
    ? `S${episode.seasonNumber}:A${episode.episodeNumber}${episode.title ? ` · ${episode.title}` : ''}`
    : undefined;
  const duration = (file.durationMs ?? 0) / 1000;
  const intro = useIntro(context);
  const { isAdmin } = useAuth();
  // What this profile skips by itself (Profiel, or the player's settings).
  const [skipSettings, setSkipSettings] = useState<SkipSettings | undefined>(context.skip);
  const changeSkip = useCallback((change: Partial<SkipSettings>) => {
    setSkipSettings((current) => current && { ...current, ...change });
    void api.setSkipSettings(change).then(setSkipSettings, () => {});
  }, []);
  // "Intro automatisch overslaan" used to be per device: over to the profile, once.
  useEffect(() => {
    if (context.skip && !context.skip.intro && forgetDeviceAutoSkip()) {
      void api.setSkipSettings({ intro: true }).then(setSkipSettings, () => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Each part skips by itself once; seeking back into it after that is the viewer's choice.
  const autoSkipped = useRef(new Set<string>());
  // "Aftiteling bekijken": no next-episode card during these credits.
  const [watchCredits, setWatchCredits] = useState(false);

  const [quality, setQuality] = useState<Quality>(savedQuality);
  // The audio chosen for this show before (any device), or Japanese for anime.
  const [audioTrack, setAudioTrack] = useState(() =>
    chooseAudioTrack(file.audioTracks, context.tracks?.audioLanguage),
  );
  const [noDirect, setNoDirect] = useState(false);
  const plan = useMemo(
    () => planFor(file, { quality, noDirect, ...(audioTrack !== undefined && { audioTrack }) }),
    [file, quality, audioTrack, noDirect],
  );
  const planKey = JSON.stringify(plan);

  // Open where this profile stopped last time.
  const [resumedAt] = useState(() => (fromStart ? 0 : resumePoint(context.progress, duration)));
  const [source, setSource] = useState<Source>({ start: resumedAt, token: 0 });
  const [resumeNotice, setResumeNotice] = useState(resumedAt > 0);
  // Each stream has its own phase; a new stream starts out "loading".
  const stream = `${planKey}#${source.token}`;
  const [phaseOf, setPhaseOf] = useState<{ stream: string; phase: Phase }>();
  const phase: Phase = phaseOf?.stream === stream ? phaseOf.phase : { kind: 'loading' };

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The element as state too, for the components that listen to it.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    setVideo(element);
  }, []);

  const [position, setPosition] = useState(0);
  const [showStats, setShowStats] = useState(false);
  // Where the HLS stream starts in the file, for the subtitle cues (direct play: 0).
  const [sessionStart, setSessionStart] = useState(0);
  const offset = useRef(0);
  const positionRef = useRef(resumedAt);
  const [engine, setEngine] = useState<Engine>();
  const engineRef = useRef<Engine>(undefined);
  const restarts = useRef(0);
  // The HLS session was let go during a long pause (PARK_MS): errors are expected.
  const parkedRef = useRef(false);

  const restartAt = useCallback((start: number) => {
    setSource((s) => ({ start: Math.max(0, start), token: s.token + 1 }));
  }, []);

  // Casting to a Chromecast (Chrome): this page is the remote, the video stops here.
  const cast = useCast();
  const castSession = cast.session;
  const castPosition = useCallback((seconds: number) => {
    positionRef.current = seconds;
  }, []);
  // Back from the TV: go on here where the TV was.
  const wasCasting = useRef(false);
  useEffect(() => {
    if (castSession) {
      wasCasting.current = true;
      return;
    }
    if (!wasCasting.current) return;
    wasCasting.current = false;
    const timer = setTimeout(() => restartAt(positionRef.current), 0);
    return () => clearTimeout(timer);
  }, [castSession, restartAt]);

  // Start a stream: the file itself, or an HLS session on the transcoder.
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !video) return;
    const current = JSON.parse(planKey) as typeof plan;
    if (current.mode === 'unplayable') return;
    const setPhase = (next: Phase) => setPhaseOf({ stream, phase: next });
    let cancelled = false;
    let hls: Hls | undefined;
    let session: PlaybackSession | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let parkTimer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;

    if (current.mode === 'direct') {
      offset.current = 0;
      const start = source.start;
      const onMetadata = () => {
        if (start > 0) element.currentTime = start;
        playQuietly(element);
      };
      element.addEventListener('loadedmetadata', onMetadata, { once: true });
      element.src = api.streamUrl(file.id);
      return () => {
        element.removeEventListener('loadedmetadata', onMetadata);
        element.removeAttribute('src');
        element.load();
      };
    }

    // Until the session says where it really starts: the old stream's "time 0"
    // (from removing its source) must not move the position back to its start.
    offset.current = source.start;

    async function startSession(media: HTMLVideoElement) {
      if (current.mode !== 'remux' && current.mode !== 'transcode') return;
      try {
        session = await api.startPlayback({
          fileId: file.id,
          start: source.start,
          video: current.video,
          ...(current.audio && { audio: current.audio, audioTrack: current.audioTrack }),
        });
        // Gone while it started (a seek, another quality, back): the cleanup didn't know it yet.
        if (cancelled) {
          void api.stopPlayback(session.id).catch(() => {});
          return;
        }
        // Waiting for a free transcode slot.
        while (!cancelled && session.status === 'queued') {
          setPhase({
            kind: 'queued',
            ...(session.queuePosition && { position: session.queuePosition }),
          });
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          if (!cancelled) session = await api.playbackSession(session.id);
        }
        if (cancelled) return;
        if (session.status === 'failed')
          throw new Error(session.error ?? 'het omzetten is mislukt');
        offset.current = session.start;
        setSessionStart(session.start);

        const playlist = api.resolveUrl(session.playlistUrl) ?? session.playlistUrl;
        const native = nativeHls(media);
        const HlsClass = native ? undefined : (await import('hls.js')).default;
        if (cancelled) return;
        engineRef.current = HlsClass?.isSupported() ? 'hls.js' : 'native';
        setEngine(engineRef.current);
        if (!HlsClass || !HlsClass.isSupported()) {
          // Safari (and iOS) play HLS themselves.
          media.src = playlist;
        } else {
          // The server makes segments as it goes; give it time before failing.
          const patient = {
            default: {
              maxTimeToFirstByteMs: 45_000,
              maxLoadTimeMs: 90_000,
              timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
              errorRetry: { maxNumRetry: 8, retryDelayMs: 1_000, maxRetryDelayMs: 4_000 },
            },
          };
          // A 4K remux is up to 10 MB a second: keep the buffers within what browsers allow.
          const seconds = bufferSeconds(file.bitrate);
          hls = new HlsClass({
            startPosition: 0,
            backBufferLength: seconds,
            maxBufferLength: seconds,
            maxMaxBufferLength: seconds * 2,
            manifestLoadPolicy: patient,
            playlistLoadPolicy: patient,
            fragLoadPolicy: patient,
          });
          let recovered = false;
          hls.on(HlsClass.Events.ERROR, (_event, data) => {
            if (!data.fatal || parkedRef.current) return;
            if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && !recovered) {
              recovered = true;
              hls?.recoverMediaError();
              return;
            }
            // E.g. a segment the server already deleted: start again where we are.
            if (restarts.current < 3) {
              restarts.current++;
              restartAt(positionRef.current);
            } else {
              setPhase({ kind: 'error', message: `het afspelen stopte (${data.details})` });
            }
          });
          hls.loadSource(playlist);
          hls.attachMedia(media);
        }
        playQuietly(media);
        parkedRef.current = false;
        const park = () => {
          if (media.ended || !session) return;
          parkedRef.current = true;
          hls?.stopLoad();
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          void api.stopPlayback(session.id).catch(() => {});
          session = undefined;
        };
        const onPause = () => {
          clearTimeout(parkTimer);
          parkTimer = setTimeout(park, PARK_MS);
        };
        const onPlay = () => {
          clearTimeout(parkTimer);
          if (parkedRef.current) restartAt(positionRef.current);
        };
        media.addEventListener('pause', onPause);
        media.addEventListener('play', onPlay);
        unlisten = () => {
          media.removeEventListener('pause', onPause);
          media.removeEventListener('play', onPlay);
        };
        heartbeat = setInterval(() => {
          if (!session) return;
          api.playbackSession(session.id).then(
            (s) => {
              if (s.status === 'failed') {
                setPhase({ kind: 'error', message: s.error ?? 'het omzetten is mislukt' });
              }
            },
            () => {},
          );
        }, HEARTBEAT_MS);
      } catch (error) {
        if (!cancelled) setPhase({ kind: 'error', message: message(error) });
      }
    }
    void startSession(element);

    return () => {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(parkTimer);
      unlisten?.();
      hls?.destroy();
      element.removeAttribute('src');
      element.load();
      if (session) void api.stopPlayback(session.id).catch(() => {});
    };
  }, [video, planKey, stream, source, file.id, file.bitrate, restartAt]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !video) return;
    const onTime = () => {
      const now = offset.current + element.currentTime;
      positionRef.current = now;
      setPosition(now);
    };
    const onPlaying = () => {
      restarts.current = 0;
      setPhaseOf({ stream, phase: { kind: 'playing' } });
    };
    const onError = () => {
      if (plan.mode !== 'direct') {
        // hls.js reports its own errors; Safari's player only reports here.
        if (engineRef.current !== 'native' || !element.getAttribute('src')) return;
        if (parkedRef.current) return;
        if (restarts.current < 3) {
          restarts.current++;
          restartAt(positionRef.current);
        } else {
          setPhaseOf({
            stream,
            phase: {
              kind: 'error',
              message: `het afspelen stopte (${element.error?.message || `fout ${element.error?.code ?? '?'}`})`,
            },
          });
        }
        return;
      }
      const code = element.error?.code;
      if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE) {
        // The browser said "maybe" and then couldn't: let the server repackage it.
        setNoDirect(true);
        restartAt(positionRef.current);
      } else {
        setPhaseOf({
          stream,
          phase: { kind: 'error', message: 'het laden van het bestand is mislukt' },
        });
      }
    };
    element.addEventListener('timeupdate', onTime);
    element.addEventListener('playing', onPlaying);
    element.addEventListener('error', onError);
    return () => {
      element.removeEventListener('timeupdate', onTime);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('error', onError);
    };
  }, [video, stream, plan.mode, restartAt]);

  const seek = useCallback(
    (target: number) => {
      const element = videoRef.current;
      if (!element) return;
      const to = Math.min(Math.max(0, target), Math.max(0, duration - 1));
      if (plan.mode === 'direct') {
        element.currentTime = to;
        return;
      }
      const relative = to - offset.current;
      // Safari's own player can't wait for segments beyond what the playlist lists.
      const ahead = engineRef.current === 'native' ? 0 : AHEAD_WINDOW;
      const inStream =
        relative >= 0 &&
        relative <= seekableEnd(element) + ahead &&
        to >= positionRef.current - BACK_WINDOW;
      if (inStream) element.currentTime = relative;
      else restartAt(to);
      positionRef.current = to;
      setPosition(to);
    },
    [duration, plan.mode, restartAt],
  );

  /** Starts a new stream at the current position only when the plan changes. */
  function replan(options: { quality: Quality; audioTrack: number | undefined }) {
    const next = planFor(file, {
      quality: options.quality,
      noDirect,
      ...(options.audioTrack !== undefined && { audioTrack: options.audioTrack }),
    });
    if (JSON.stringify(next) !== planKey) restartAt(positionRef.current);
  }

  function changeQuality(next: Quality) {
    saveQuality(next);
    setQuality(next);
    replan({ quality: next, audioTrack });
  }

  function changeAudio(index: number) {
    setAudioTrack(index);
    replan({ quality, audioTrack: index });
    // The next episodes start with it too.
    const language = languageCode(file.audioTracks.find((t) => t.index === index)?.language);
    saveTracks({ audioLanguage: language ?? null });
  }

  const saveTracks = useCallback(
    (choice: TrackChoiceUpdate) => void api.setTracks(item.id, choice).catch(() => {}),
    [item.id],
  );
  const saveSubtitle = useCallback(
    (subtitle: string | null) => saveTracks({ subtitle }),
    [saveTracks],
  );

  const ended = useProgressReporter({ fileId: file.id, video, position: positionRef, duration });
  const playNext = useCallback(() => {
    if (next) void navigate(`/play/${next.fileId}`);
  }, [navigate, next]);
  const isPaused = useCallback(() => video?.paused ?? false, [video]);

  // The one skip button of the moment: intro, recap, preview, or (no next episode) the credits.
  const skip = skipChoice(intro, position, duration, Boolean(next));
  const auto = autoSkip(intro, position, duration, Boolean(next), skipSettings, NOTHING_SKIPPED);
  useEffect(() => {
    if (!auto || autoSkipped.current.has(auto.key)) return;
    autoSkipped.current.add(auto.key);
    const { next: toNext, to } = auto;
    // Out of the effect: seeking starts a new stream (state).
    const timer = setTimeout(() => (toNext ? playNext() : to !== undefined && seek(to)), 0);
    return () => clearTimeout(timer);
    // seek is a plain function of this render; the part decides.
  }, [auto?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // The end credits: the next episode (with a countdown), or a skip to a scene after them.
  const atCredits = Boolean(intro.credits && inCredits(intro.credits, position));
  const nextAtCredits = Boolean(next && atCredits && !watchCredits && !ended);

  useEffect(() => {
    if (!resumeNotice) return;
    const timer = setTimeout(() => setResumeNotice(false), RESUME_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [resumeNotice]);

  const summary = planSummary(plan);
  const tracks: AudioTrack[] = file.audioTracks;
  const currentTrack =
    plan.mode === 'remux' || plan.mode === 'transcode'
      ? plan.audioTrack
      : (tracks.find((t) => t.default) ?? tracks[0])?.index;
  const audioLanguage = languageCode(tracks.find((t) => t.index === currentTrack)?.language);
  const subtitles = useSubtitles({
    file,
    video,
    streamStart: plan.mode === 'direct' ? 0 : sessionStart,
    position,
    audioLanguage,
    ...(context.tracks?.subtitle && { forShow: context.tracks.subtitle }),
    onChoose: saveSubtitle,
  });

  useWakeLock(video);

  // Pictures for the timeline: made by the server while nobody watches.
  const thumbnails = useQuery({
    queryKey: keys.thumbnails(file.id),
    queryFn: () => api.thumbnails(file.id),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  useMediaSession({
    video,
    title: episodeLine ? `${episodeLine}` : title,
    artist: episodeLine ? title : item.year ? String(item.year) : 'CineVault',
    artwork: item.posterUrl,
    position,
    duration,
    onSeek: seek,
    onNext: next ? playNext : undefined,
  });

  const loadingText =
    phase.kind === 'loading' && plan.mode !== 'direct'
      ? plan.mode === 'transcode'
        ? 'De server zet de video om…'
        : 'De server pakt de video om…'
      : undefined;

  return (
    <div className="player-page">
      {castSession ? (
        <CastView
          session={castSession}
          device={cast.device}
          context={context}
          startAt={() => positionRef.current}
          quality={quality}
          audioTrack={currentTrack}
          subtitle={
            subtitles.selected
              ? { option: subtitles.selected, shiftMs: subtitles.shiftMs }
              : undefined
          }
          subtitles={subtitles.options}
          onSubtitle={subtitles.select}
          intro={intro}
          title={title}
          line={episodeLine}
          backTo={backTo}
          onPosition={castPosition}
          onPlayNext={playNext}
        />
      ) : plan.mode === 'unplayable' ? (
        <div className="player-message">
          <Link to={backTo} className="icon-button player-back" aria-label="Terug naar de titel">
            <Icon name="back" />
          </Link>
          <Icon name="alert" size={48} />
          <h1>Deze browser kan dit bestand niet afspelen</h1>
          <p>{summary}.</p>
          <p className="muted">
            Ook omzetten helpt hier niet: deze browser speelt geen H.264 of AAC. Probeer Chrome,
            Edge, Firefox of Safari.
          </p>
        </div>
      ) : (
        <PlayerControls
          video={video}
          videoRef={attachVideo}
          position={position}
          duration={duration}
          offset={plan.mode === 'direct' ? 0 : sessionStart}
          onSeek={seek}
          title={title}
          {...(episodeLine && { subtitle: episodeLine })}
          backTo={backTo}
          quality={quality}
          onQuality={changeQuality}
          tracks={tracks}
          audioTrack={currentTrack}
          onAudioTrack={changeAudio}
          thumbnails={thumbnails.data?.thumbnails}
          onCast={cast.ready && cast.devices ? () => void startCasting() : undefined}
          statsShown={showStats}
          onStats={() => setShowStats((shown) => !shown)}
          subtitlesOn={Boolean(subtitles.selected)}
          subtitlePanel={
            <SubtitlePanel
              fileId={file.id}
              options={subtitles.options}
              {...(subtitles.selected && { selected: subtitles.selected })}
              onSelect={subtitles.select}
              status={subtitles.status}
              shiftMs={subtitles.shiftMs}
              onShift={subtitles.changeShift}
              onAdded={subtitles.added}
              onReadAsText={(option) => void subtitles.readAsText(option)}
              {...(subtitles.readError && { readError: subtitles.readError })}
            />
          }
          onSkipIntro={skip ? () => seek(skip.to) : undefined}
          {...(skip && { skipLabel: skip.label, skipKey: skip.key })}
          skipSettings={skipSettings}
          onSkipSettings={changeSkip}
          introEditor={
            isAdmin ? (
              <IntroEditor fileId={file.id} info={intro} position={position} duration={duration} />
            ) : undefined
          }
          next={
            next
              ? {
                  label: `S${next.seasonNumber}:A${next.episodeNumber}${next.title ? ` · ${next.title}` : ''}`,
                  onPlay: playNext,
                }
              : undefined
          }
        >
          {showStats && (
            <PlaybackStats
              video={video}
              file={file}
              streamUrl={api.streamUrl(file.id)}
              mode={
                plan.mode === 'direct' || !engine
                  ? summary
                  : `${summary}; HLS via ${engine === 'native' ? 'de speler van de browser' : 'hls.js'}`
              }
              onClose={() => setShowStats(false)}
            />
          )}
          {resumeNotice && phase.kind !== 'error' && (
            <div className="player-notice" role="status">
              <span>Verder vanaf {clockLabel(resumedAt)}</span>
              <button
                type="button"
                className="pill-button"
                onClick={() => {
                  setResumeNotice(false);
                  seek(0);
                }}
              >
                Vanaf het begin
              </button>
            </div>
          )}
          {nextAtCredits && next && (
            <NextEpisode
              next={next}
              onPlay={playNext}
              cancelLabel="Aftiteling bekijken"
              onCancel={() => setWatchCredits(true)}
              isPaused={isPaused}
            />
          )}
          {ended && next && !nextAtCredits && (
            <NextEpisode
              next={next}
              onPlay={playNext}
              cancelLabel="Stoppen"
              onCancel={() => void navigate(backTo)}
            />
          )}
          {phase.kind === 'queued' && (
            <div className="player-message overlay" role="status">
              <span className="player-spinner inline" aria-hidden="true" />
              <p>
                In de wachtrij{phase.position ? ` (plek ${phase.position})` : ''}: de server is al
                met andere video&apos;s bezig.
              </p>
            </div>
          )}
          {loadingText && (
            <div className="player-message overlay subtle" role="status">
              <p>{loadingText}</p>
            </div>
          )}
          {phase.kind === 'error' && (
            <div className="player-message overlay" role="alert">
              <Icon name="alert" size={36} />
              <p>Afspelen lukt niet: {phase.message}.</p>
              <p className="muted">{summary}.</p>
              <button
                type="button"
                className="button primary"
                onClick={() => restartAt(positionRef.current)}
              >
                Opnieuw proberen
              </button>
            </div>
          )}
        </PlayerControls>
      )}
    </div>
  );
}

/**
 * The screen stays on while the video plays (phones and tablets turn it off
 * otherwise). The browser lets go of the lock when the tab is hidden; it is
 * asked for again when the tab comes back.
 */
function useWakeLock(video: HTMLVideoElement | null) {
  useEffect(() => {
    if (!video || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let wanted = false;
    let asking = false;
    const take = () => {
      if (lock || asking || document.hidden) return;
      asking = true;
      navigator.wakeLock.request('screen').then(
        (sentinel) => {
          asking = false;
          if (!wanted) return void sentinel.release().catch(() => {});
          lock = sentinel;
          sentinel.addEventListener('release', () => {
            if (lock === sentinel) lock = undefined;
          });
        },
        () => {
          // Not allowed (no HTTPS, battery saver): the screen goes off as before.
          asking = false;
        },
      );
    };
    const onPlaying = () => {
      wanted = true;
      take();
    };
    const onStop = () => {
      wanted = false;
      void lock?.release().catch(() => {});
      lock = undefined;
    };
    const onVisible = () => {
      if (wanted && !document.hidden) take();
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onStop);
    video.addEventListener('ended', onStop);
    document.addEventListener('visibilitychange', onVisible);
    if (!video.paused) onPlaying();
    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onStop);
      video.removeEventListener('ended', onStop);
      document.removeEventListener('visibilitychange', onVisible);
      onStop();
    };
  }, [video]);
}

/**
 * The lock screen, media keys, headphones and TV remotes: title, artwork,
 * play and pause, seeking and the next episode.
 */
function useMediaSession({
  video,
  title,
  artist,
  artwork,
  position,
  duration,
  onSeek,
  onNext,
}: {
  video: HTMLVideoElement | null;
  title: string;
  artist: string;
  artwork?: string | undefined;
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
  onNext?: (() => void) | undefined;
}) {
  const latest = useRef({ position, onSeek, onNext });
  useEffect(() => {
    latest.current = { position, onSeek, onNext };
  });
  useEffect(() => {
    if (!video || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    try {
      session.metadata = new MediaMetadata({
        title,
        artist,
        album: 'CineVault',
        ...(artwork && { artwork: [{ src: new URL(artwork, location.href).href }] }),
      });
    } catch {
      // MediaMetadata missing (older browsers).
    }
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', () => playQuietly(video)],
      ['pause', () => video.pause()],
      [
        'seekbackward',
        (d) => latest.current.onSeek(latest.current.position - (d.seekOffset ?? 10)),
      ],
      ['seekforward', (d) => latest.current.onSeek(latest.current.position + (d.seekOffset ?? 10))],
      ['seekto', (d) => d.seekTime !== undefined && latest.current.onSeek(d.seekTime)],
      ['nexttrack', onNext ? () => latest.current.onNext?.() : null],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not supported here.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Not supported here.
        }
      }
    };
  }, [video, title, artist, artwork, onNext]);

  // The position on the lock screen, every few seconds.
  const second = Math.floor(position / 5);
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !duration) return;
    try {
      navigator.mediaSession.setPositionState?.({
        duration,
        position: Math.min(duration, Math.max(0, latest.current.position)),
        playbackRate: 1,
      });
    } catch {
      // Inconsistent values while a new stream starts.
    }
  }, [second, duration]);
}
