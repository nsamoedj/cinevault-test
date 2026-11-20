// The player: direct play when the phone decodes the file, otherwise an HLS
// session on the transcoder (remux or transcode), as in the web app. The
// timeline is the whole file; an HLS session starts somewhere in it, so the
// position is the session's start plus the player's time.

import {
  audioCodecString,
  chooseAudioTrack,
  cuesAt,
  type FileContext,
  inCredits,
  languageCode,
  type PictureArea,
  type PlaybackPlan,
  type PlaybackSession,
  planPlayback,
  type Quality,
  resumePoint,
  type TrackChoiceUpdate,
  videoCodecString,
  skipChoice,
} from '@cinevault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEvent, useEventListener } from 'expo';
import { router } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { stopThemeMusic } from '../themeMusic';
import { useVideoPlayer, type VideoPlayer, type VideoSource, VideoView } from 'expo-video';
import { supportsDecoder } from '../../modules/cinevault-media';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useRemoteMediaClient } from 'react-native-google-cast';
import { isCar, px, useDrivingRestricted } from '../car';
import { keys } from '../keys';
import { isTV } from '../tv/focus';
import { TvControls } from '../tv/TvControls';
import { androidDevice, withoutCodecs } from '../playback/device';
import {
  failedAudioCodecs,
  saveFailedAudioCodec,
  savedFit,
  saveFit,
  savedQuality,
  saveQuality,
} from '../preferences';
import { useSession } from '../session';
import { colors } from '../theme';
import { CastPlayer } from './CastPlayer';
import { Controls, type ControlsProps } from './Controls';
import { contentFit, type FitMode } from './fit';
import { planText } from './summary';
import { useCues } from './useCues';
import { useIntro } from './useIntro';
import { useAutoSkip, useSkipFresh, useSkipSettings } from './skip';
import { IntroEditor } from '../admin/IntroEditor';

const REPORT_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const KEEP_AWAKE_TAG = 'cinevault-player';
/**
 * Paused this long, an HLS stream lets its session go: the transcoder would
 * otherwise write the rest of the film to disk (and keep a transcode slot).
 * Playing again starts a new session at the same spot.
 */
const PARK_MS = 10 * 60_000;
/** Seeks this far behind the position stay in the stream (the transcoder keeps 10 min). */
const BACK_WINDOW = 300;
const NEXT_COUNTDOWN = 10;
/** An end this far before the end of the file is not the end (seconds, or 2%). */
const END_MARGIN = 30;
/**
 * How long the first stream waits for the black-bar check: the picture fit is
 * settled before the first frame, because changing it while the video plays
 * makes the picture jump. A check that takes longer counts from the next time.
 */
const PICTURE_WAIT_MS = 1_500;

type Phase =
  | { kind: 'loading' }
  | { kind: 'queued'; position?: number }
  | { kind: 'playing' }
  | { kind: 'error'; message: string };

interface Source {
  start: number;
  token: number;
}

const phone = androidDevice(supportsDecoder);

// No Chromecast from a TV (it is the screen itself) or a car.
const useCastClient: typeof useRemoteMediaClient =
  isTV || isCar ? () => null : useRemoteMediaClient;

// The player is a native object: change it through these, not in render.
function seekTo(player: VideoPlayer, seconds: number) {
  player.currentTime = seconds;
}

function load(player: VideoPlayer, source: VideoSource, start = 0) {
  player.replace(source);
  if (start > 0) seekTo(player, start);
  player.play();
}

export function Player({ context, fromStart }: { context: FileContext; fromStart: boolean }) {
  const { file, item, episode, next } = context;
  const { api, authHeaders, user } = useSession();
  const admin = user?.role === 'ADMIN';
  const queryClient = useQueryClient();
  const duration = (file.durationMs ?? 0) / 1000;
  const markers = useIntro(context);
  const intro = markers.intro;
  const credits = markers.credits;
  const recap = markers.recap;
  // What this profile skips by itself (on every device).
  const [skipSettings, changeSkip] = useSkipSettings(context.skip);
  // "Aftiteling bekijken": no next-episode card during these credits.
  const [watchCredits, setWatchCredits] = useState(false);

  const [quality, setQuality] = useState<Quality>(savedQuality);
  // Connected to a Chromecast: it plays there, and this player waits.
  const castClient = useCastClient();
  const casting = castClient !== null;
  // The setting, and a pinch that overrides it for this video.
  const [fitMode, setFitMode] = useState<FitMode>(savedFit);
  const [pinched, setPinched] = useState<FitMode>();
  // The subtitles move up while the controls are in view, so they stay readable.
  const [controlsUp, setControlsUp] = useState(false);
  const screen = useWindowDimensions();
  const pictureQuery = useMemo(
    () => ({
      queryKey: keys.picture(file.id),
      queryFn: () => api.picture(file.id),
      staleTime: Infinity,
      retry: false,
    }),
    [api, file.id],
  );
  const picture = useQuery(pictureQuery);
  // What the automatic fit goes by, fixed once the first frame is there.
  const [settledArea, setSettledArea] = useState<{ area?: PictureArea }>();
  const fit = contentFit(
    pinched ?? fitMode,
    { width: file.width ?? 0, height: file.height ?? 0 },
    settledArea ? settledArea.area : picture.data?.area,
    screen,
  );
  // The audio chosen for this show before (any device), or Japanese for anime.
  const [audioTrack, setAudioTrack] = useState(() =>
    chooseAudioTrack(file.audioTracks, context.tracks?.audioLanguage),
  );
  const [noDirect, setNoDirect] = useState(false);
  // Codecs whose decoder failed: audio ones for good (on this phone), video
  // ones for this file only.
  const [failed, setFailed] = useState<string[]>(failedAudioCodecs);
  const device = useMemo(() => withoutCodecs(phone, failed), [failed]);
  const plan: PlaybackPlan = useMemo(
    () =>
      planPlayback(file, device, {
        quality,
        noDirect,
        ...(audioTrack !== undefined && { audioTrack }),
      }),
    [file, device, quality, audioTrack, noDirect],
  );
  const planKey = JSON.stringify(plan);
  const tracks = file.audioTracks;
  const currentTrack =
    plan.mode === 'remux' || plan.mode === 'transcode'
      ? plan.audioTrack
      : (tracks.find((t) => t.default) ?? tracks[0])?.index;

  const [resumedAt] = useState(() => (fromStart ? 0 : resumePoint(context.progress, duration)));
  const [source, setSource] = useState<Source>({ start: resumedAt, token: 0 });
  // Each stream has its own phase and start; a new stream starts out "loading".
  const stream = `${planKey}#${source.token}`;
  const [phaseOf, setPhaseOf] = useState<{ stream: string; phase: Phase }>();
  const phase: Phase = phaseOf?.stream === stream ? phaseOf.phase : { kind: 'loading' };
  // The next episode's black-bar check, done while this one plays.
  useQuery({
    queryKey: keys.picture(next?.fileId ?? ''),
    queryFn: () => api.picture(next?.fileId ?? ''),
    enabled: Boolean(next) && phase.kind === 'playing',
    staleTime: Infinity,
    retry: false,
  });
  const [offsetOf, setOffsetOf] = useState<{ stream: string; offset: number }>();
  const offset =
    plan.mode === 'direct' ? 0 : offsetOf?.stream === stream ? offsetOf.offset : source.start;
  const offsetRef = useRef(0);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  const positionRef = useRef(resumedAt);
  // The HLS session was let go during a long pause (PARK_MS): errors are expected.
  const parkedRef = useRef(false);
  const restarts = useRef(0);
  const earlyEnds = useRef(0);
  // Whether the current stream got going; until then an "end" is not ours.
  const started = useRef(false);
  const [ended, setEnded] = useState(false);
  const [left, setLeft] = useState(NEXT_COUNTDOWN);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.5;
    p.keepScreenOnWhilePlaying = true;
  });
  const time = useEvent(player, 'timeUpdate', { currentTime: 0 } as never);
  const playing = useEvent(player, 'playingChange', { isPlaying: false } as never);
  const status = useEvent(player, 'statusChange', { status: 'idle' } as never);
  const position = offset + ((time as { currentTime?: number } | null)?.currentTime ?? 0);
  const isPlaying = Boolean((playing as { isPlaying?: boolean } | null)?.isPlaying);
  const buffering = (status as { status?: string } | null)?.status === 'loading';

  // In a car, video only plays while parked. When it drives, the system covers
  // the app: pause, and stay paused (also when a new stream or the next
  // episode would start) until the viewer presses play while parked again.
  const driving = useDrivingRestricted();
  const drivingRef = useRef(driving);
  useEffect(() => {
    drivingRef.current = driving;
    if (driving) player.pause();
  }, [driving, player]);
  useEffect(() => {
    if (!isCar) return;
    const playingChange = player.addListener('playingChange', ({ isPlaying }) => {
      if (isPlaying && drivingRef.current) player.pause();
    });
    // Covered by the system or by another app: pause as well.
    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active') player.pause();
    });
    return () => {
      playingChange.remove();
      appState.remove();
    };
  }, [player]);

  // The screen stays on while a video plays or loads. expo-video's own
  // keepScreenOnWhilePlaying only reaches the VideoView of that moment, and a
  // new picture fit gives a new one: then the screen went off mid-film.
  const awake = isPlaying || buffering;
  // Theme music of the page before (it would fade out only after a moment): quiet at once.
  useEffect(() => stopThemeMusic(), []);

  useEffect(() => {
    if (!awake) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }, [awake]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  const restartAt = useCallback((start: number) => {
    setEnded(false);
    setLeft(NEXT_COUNTDOWN);
    setSource((s) => ({ start: Math.max(0, start), token: s.token + 1 }));
  }, []);

  const title = item.title;
  const subtitle = episode
    ? `S${episode.seasonNumber}:A${episode.episodeNumber}${episode.title ? ` · ${episode.title}` : ''}`
    : undefined;
  const metadata = useMemo(
    () => ({
      title: subtitle ?? title,
      artist: subtitle ? title : 'CineVault',
      ...(api.resolveUrl(item.posterUrl) && { artwork: api.resolveUrl(item.posterUrl) }),
    }),
    [api, item.posterUrl, subtitle, title],
  );

  // A video that plays stays on its address: when the app switches between
  // home and the domain, the next stream (a seek, another quality) takes the new one.
  const streamWith = useRef({ api, authHeaders, metadata, pictureQuery });
  useEffect(() => {
    streamWith.current = { api, authHeaders, metadata, pictureQuery };
  }, [api, authHeaders, metadata, pictureQuery]);

  // Start a stream: the file itself, or an HLS session on the transcoder.
  useEffect(() => {
    const { api, authHeaders, metadata, pictureQuery } = streamWith.current;
    const current = JSON.parse(planKey) as PlaybackPlan;
    if (casting) {
      player.pause();
      return;
    }
    if (current.mode === 'unplayable') return;
    let cancelled = false;
    let session: PlaybackSession | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let parkTimer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const setPhase = (next: Phase) => setPhaseOf({ stream, phase: next });
    started.current = false;

    const pictureReady = Promise.race([
      queryClient.fetchQuery(pictureQuery).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, PICTURE_WAIT_MS)),
    ]);

    if (current.mode === 'direct') {
      offsetRef.current = 0;
      void pictureReady.then(() => {
        if (cancelled) return;
        load(player, { uri: api.streamUrl(file.id), headers: authHeaders, metadata }, source.start);
      });
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        session = await api.startPlayback({
          fileId: file.id,
          start: source.start,
          video: current.video,
          ...(current.audio && { audio: current.audio, audioTrack: current.audioTrack }),
        });
        // Gone while it started (back, a far seek, another quality): the cleanup didn't know it yet.
        if (cancelled) {
          void api.stopPlayback(session.id).catch(() => {});
          return;
        }
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
        await pictureReady;
        if (cancelled) return;
        offsetRef.current = session.start;
        setOffsetOf({ stream, offset: session.start });
        const playlist = api.resolveUrl(session.playlistUrl) ?? session.playlistUrl;
        load(player, { uri: playlist, headers: authHeaders, contentType: 'hls', metadata });
        const id = session.id;
        parkedRef.current = false;
        const park = () => {
          if (!session) return;
          parkedRef.current = true;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          void api.stopPlayback(session.id).catch(() => {});
          session = undefined;
        };
        const playing = player.addListener('playingChange', ({ isPlaying }) => {
          clearTimeout(parkTimer);
          if (isPlaying && parkedRef.current) restartAt(positionRef.current);
          else if (!isPlaying) parkTimer = setTimeout(park, PARK_MS);
        });
        unlisten = () => playing.remove();
        heartbeat = setInterval(() => {
          api.playbackSession(id).then(
            (s) => {
              if (s.status === 'failed')
                setPhase({ kind: 'error', message: s.error ?? 'het omzetten is mislukt' });
            },
            () => {},
          );
        }, HEARTBEAT_MS);
      } catch (error) {
        if (!cancelled) {
          setPhase({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(parkTimer);
      unlisten?.();
      if (session) void api.stopPlayback(session.id).catch(() => {});
    };
  }, [casting, planKey, stream, source, player, file.id, queryClient, restartAt]);

  // Progress for "Verder kijken": every few seconds, on pause, at the end, on leaving.
  const lastSent = useRef(-1);
  const report = useCallback(
    (end = false) => {
      const at = end ? duration || positionRef.current : positionRef.current;
      if (!end && (at < 5 || Math.abs(at - lastSent.current) < 1)) return;
      lastSent.current = at;
      void api
        .reportProgress(file.id, Math.round(at * 1000), file.durationMs || undefined)
        .catch(() => {});
    },
    [api, duration, file.durationMs, file.id],
  );
  useEventListener(player, 'statusChange', ({ status: next, error }) => {
    if (next === 'readyToPlay') {
      restarts.current = 0;
      started.current = true;
      const area = picture.data?.area;
      setSettledArea((settled) => settled ?? (area ? { area } : {}));
      setPhaseOf({ stream, phase: { kind: 'playing' } });
      return;
    }
    if (next !== 'error') return;
    // The session was let go during a long pause: the next play starts a new one.
    if (parkedRef.current) return;
    // A decoder that said it could, but failed: let the server convert that
    // part (audio to AAC, video to H.264) and go on where it stopped.
    const renderer = /MediaCodec(Audio|Video)Renderer/.exec(error?.message ?? '')?.[1];
    const codec =
      renderer === 'Audio'
        ? audioCodecString(tracks.find((t) => t.index === currentTrack)?.codec ?? '')
        : renderer === 'Video'
          ? videoCodecString(file)
          : undefined;
    if (codec && !failed.includes(codec)) {
      if (renderer === 'Audio') saveFailedAudioCodec(codec);
      setFailed([...failed, codec]);
      restartAt(positionRef.current);
      return;
    }
    // A repackaged stream whose loading keeps failing (no decoder in it, e.g.
    // "Source error Unexpected IllegalArgumentException" at 18:32 of Lupin,
    // 2026-11-12): after one more try the server converts the picture too
    // (H.264), for this file, and it goes on where it stopped.
    const copied = plan.mode === 'remux' && plan.video.mode === 'copy';
    const video = copied ? videoCodecString(file) : undefined;
    if (
      video &&
      !failed.includes(video) &&
      restarts.current >= 1 &&
      /source error/i.test(error?.message ?? '')
    ) {
      setFailed([...failed, video]);
      restartAt(positionRef.current);
      return;
    }
    if (plan.mode === 'direct') {
      // The phone said it could, but couldn't: let the server repackage it.
      setNoDirect(true);
      restartAt(positionRef.current);
    } else if (restarts.current < 3) {
      restarts.current++;
      restartAt(positionRef.current);
    } else {
      setPhaseOf({
        stream,
        phase: { kind: 'error', message: error?.message ?? 'het afspelen stopte' },
      });
    }
  });

  // expo-video also reports an end for the empty player before the first
  // stream has loaded, and a stream can stop early: only the end of the file
  // counts. An early end picks up again where it stopped.
  useEventListener(player, 'playToEnd', () => {
    if (!started.current) return;
    const at = positionRef.current;
    if (duration > 0 && at < duration - Math.max(END_MARGIN, duration * 0.02)) {
      if (earlyEnds.current < 2) {
        earlyEnds.current++;
        restartAt(at);
      }
      return;
    }
    report(true);
    setEnded(true);
  });

  const seek = useCallback(
    (target: number) => {
      const to = Math.min(Math.max(0, target), Math.max(0, duration - 1));
      setEnded(false);
      setLeft(NEXT_COUNTDOWN);
      if (plan.mode === 'direct') {
        seekTo(player, to);
        return;
      }
      const relative = to - offsetRef.current;
      const available = player.duration || 0;
      const inStream =
        relative >= 0 && relative <= available && to >= positionRef.current - BACK_WINDOW;
      if (inStream) seekTo(player, relative);
      else restartAt(to);
    },
    [duration, plan.mode, player, restartAt],
  );

  useEffect(() => {
    if (!isPlaying) {
      report();
      return;
    }
    const timer = setInterval(() => report(), REPORT_MS);
    return () => clearInterval(timer);
  }, [isPlaying, report]);
  useEffect(
    () => () => {
      report();
      void queryClient.invalidateQueries({ queryKey: keys.continue });
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: ['item'] });
    },
    [report, queryClient],
  );

  // Casting: the Chromecast's position is the position; when the cast ends,
  // this player goes on from there.
  const onCastPosition = useCallback((seconds: number) => {
    positionRef.current = seconds;
  }, []);
  const onCastEnded = useCallback(() => {
    report(true);
    setEnded(true);
  }, [report]);
  const wasCasting = useRef(false);
  useEffect(() => {
    if (casting) {
      wasCasting.current = true;
      return;
    }
    if (!wasCasting.current) return;
    wasCasting.current = false;
    const timer = setTimeout(() => restartAt(positionRef.current), 0);
    return () => clearTimeout(timer);
  }, [casting, restartAt]);

  // The one skip button of the moment (intro, recap, preview, or the credits without a
  // next episode): for 8 s when its part starts, then with the controls.
  const skip = skipChoice(markers, position, duration, Boolean(next));
  const skipFresh = useSkipFresh(skip?.key);
  const playNext = useCallback(() => {
    if (next) router.replace(`/play/${next.fileId}`);
  }, [next]);
  useAutoSkip(markers, position, duration, Boolean(next), skipSettings, { seek, playNext });

  // The end credits: the next episode (with a countdown), or a skip to a scene after them.
  const atCredits = Boolean(credits && inCredits(credits, position));
  const nextAtCredits = Boolean(next && atCredits && !watchCredits && !ended);

  // The next episode starts by itself after a countdown (at the credits only while it plays).
  const counting = Boolean(next) && (ended || (nextAtCredits && isPlaying));
  useEffect(() => {
    if (!counting || !next) return;
    if (left <= 0) {
      router.replace(`/play/${next.fileId}`);
      return;
    }
    const timer = setTimeout(() => setLeft(left - 1), 1_000);
    return () => clearTimeout(timer);
  }, [counting, next, left]);

  const audioLanguage = languageCode(tracks.find((t) => t.index === currentTrack)?.language);
  // What the viewer picks, the next episodes of this show start with too.
  const saveTracks = useCallback(
    (choice: TrackChoiceUpdate) => void api.setTracks(item.id, choice).catch(() => {}),
    [api, item.id],
  );
  const saveSubtitle = useCallback(
    (subtitle: string | null) => saveTracks({ subtitle }),
    [saveTracks],
  );
  const cues = useCues({
    file,
    position,
    audioLanguage,
    forShow: context.tracks?.subtitle,
    onChoose: saveSubtitle,
  });
  const shown = cues.selected ? cuesAt(cues.cues, position - cues.shiftMs / 1000) : [];

  function replan(options: { quality: Quality; audioTrack: number | undefined }) {
    const nextPlan = planPlayback(file, device, {
      quality: options.quality,
      noDirect,
      ...(options.audioTrack !== undefined && { audioTrack: options.audioTrack }),
    });
    if (JSON.stringify(nextPlan) !== planKey) restartAt(positionRef.current);
  }

  if (castClient) {
    return (
      <CastPlayer
        client={castClient}
        context={context}
        startAt={() => positionRef.current}
        quality={quality}
        audioTrack={audioTrack}
        subtitle={cues.selected ? { option: cues.selected, shiftMs: cues.shiftMs } : undefined}
        subtitles={cues.options}
        onSubtitle={cues.select}
        title={title}
        {...(subtitle && { line: subtitle })}
        onPosition={onCastPosition}
        onEnded={onCastEnded}
        onBack={() => router.back()}
        ended={ended}
        countdown={left}
        onPlayNext={() => next && router.replace(`/play/${next.fileId}`)}
        {...(intro && { intro })}
        {...(credits && { credits })}
        {...(markers.creditsSource && { creditsSource: markers.creditsSource })}
        {...(markers.moreCredits && { moreCredits: markers.moreCredits })}
        {...(recap && { recap })}
        {...(markers.preview && { preview: markers.preview })}
        {...(skipSettings && { skip: skipSettings })}
      />
    );
  }

  if (plan.mode === 'unplayable') {
    return (
      <View style={styles.message}>
        <Text style={styles.messageTitle}>
          {isTV ? 'Deze tv' : isCar ? 'Deze auto' : 'Deze telefoon'} kan dit bestand niet afspelen
        </Text>
        <Text style={styles.messageText}>{planText(plan)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.stage}>
      <VideoView
        // A new view for a new fit: switching it on a playing view leaves the
        // picture misplaced for a while on some phones.
        key={fit}
        player={player}
        style={StyleSheet.absoluteFill}
        nativeControls={false}
        contentFit={fit}
        allowsPictureInPicture={!isTV && !isCar}
        startsPictureInPictureAutomatically={!isTV && !isCar}
      />
      {driving && (
        <View style={styles.driving} pointerEvents="none">
          {/* Above the middle, clear of the play buttons. */}
          <View style={styles.drivingText}>
            <Text style={styles.messageTitle}>Video speelt alleen als de auto stilstaat</Text>
            <Text style={styles.messageText}>Druk op afspelen als je weer geparkeerd staat.</Text>
          </View>
        </View>
      )}
      {shown.length > 0 && (
        <View
          style={[
            styles.cues,
            isTV && styles.tvCues,
            isCar && styles.carCues,
            controlsUp && !isTV && { bottom: px(isCar ? 170 : 130) },
          ]}
          pointerEvents="none"
        >
          {shown.map((cue) => (
            <Text
              key={`${cue.start}-${cue.text}`}
              style={[styles.cue, isTV && styles.tvCue, isCar && styles.carCue]}
            >
              {cue.text.replace(/<[^>]+>/g, '')}
            </Text>
          ))}
        </View>
      )}
      <ControlsView
        player={player}
        title={title}
        {...(subtitle && { subtitle })}
        position={position}
        duration={duration}
        playing={isPlaying}
        // While the car drives the video is paused on purpose: no spinner over the notice.
        buffering={!driving && (buffering || phase.kind === 'loading')}
        onSeek={seek}
        onBack={() => router.back()}
        fitMode={pinched ?? fitMode}
        onFitMode={(mode) => {
          saveFit(mode);
          setFitMode(mode);
          setPinched(undefined);
        }}
        {...(!isTV && { onPinch: (wider: boolean) => setPinched(wider ? 'fill' : 'fit') })}
        quality={quality}
        onQuality={(value) => {
          saveQuality(value);
          setQuality(value);
          replan({ quality: value, audioTrack });
        }}
        tracks={tracks}
        audioTrack={currentTrack}
        onAudioTrack={(index) => {
          setAudioTrack(index);
          replan({ quality, audioTrack: index });
          const language = languageCode(tracks.find((t) => t.index === index)?.language);
          saveTracks({ audioLanguage: language ?? null });
        }}
        cues={cues}
        onShownChange={setControlsUp}
        fileId={file.id}
        summary={planText(plan)}
        phase={phase}
        resumedAt={resumedAt}
        onRestart={() => restartAt(positionRef.current)}
        next={next}
        ended={ended || nextAtCredits}
        countdown={left}
        onPlayNext={() => next && router.replace(`/play/${next.fileId}`)}
        onSkipIntro={skip ? () => seek(skip.to) : undefined}
        {...(skip && { skipLabel: skip.label })}
        skipFresh={skipFresh}
        onWatchCredits={
          nextAtCredits
            ? () => {
                setWatchCredits(true);
                setLeft(NEXT_COUNTDOWN);
              }
            : undefined
        }
        skipSettings={skipSettings}
        onSkipSettings={changeSkip}
        {...(admin &&
          !isTV && {
            introEditor: (
              <IntroEditor
                fileId={file.id}
                info={markers}
                position={position}
                duration={duration}
              />
            ),
          })}
      />
    </View>
  );
}

/** The remote's controls on a TV, the touch controls on a phone. */
function ControlsView(
  props: Omit<ControlsProps, 'onPinch'> & Partial<Pick<ControlsProps, 'onPinch'>>,
) {
  if (isTV || !props.onPinch) return <TvControls {...props} />;
  return <Controls {...props} onPinch={props.onPinch} />;
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: '#000' },
  cues: { position: 'absolute', left: 48, right: 48, bottom: 36, alignItems: 'center', gap: 2 },
  tvCues: { left: 96, right: 96, bottom: 56 },
  tvCue: { fontSize: 30, lineHeight: 40, paddingHorizontal: 12 },
  // In a car the screen is further away than a phone, and the back seat further still.
  carCues: { left: 96, right: 96, bottom: 48 },
  carCue: { fontSize: 30, lineHeight: 40, paddingHorizontal: 12, fontWeight: '600' },
  cue: {
    color: '#fff',
    fontSize: 20,
    lineHeight: 27,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  message: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  messageTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  messageText: { color: colors.text2, fontSize: 15, textAlign: 'center' },
  driving: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(10, 18, 48, 0.88)' },
  drivingText: { position: 'absolute', top: '22%', left: 32, right: 32, gap: 12 },
});
