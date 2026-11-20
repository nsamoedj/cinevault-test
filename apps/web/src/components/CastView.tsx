// Playing on a Chromecast from the browser, as the Android app does it
// (apps/mobile/src/player/CastPlayer.tsx): an HLS session on the transcoder,
// sized for the Chromecast (castDevice), a cast link from the API, and the
// Default Media Receiver loads it. This page is then the remote. A session
// starts somewhere in the file, so the position is the session's start plus
// the receiver's position.

import {
  autoSkip,
  castDevice,
  castIs4k,
  castSubtitleChoices,
  castSubtitleUrl,
  type FileContext,
  inCredits,
  type IntroInfo,
  languageCode1,
  planPlayback,
  type Quality,
  type SubtitleOption,
  skipChoice,
} from '@cinevault/shared';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

/** autoSkip in render: what was skipped already is checked in the effect (a ref). */
const NONE: ReadonlySet<string> = new Set();
import { Link } from 'react-router';
import { api } from '../api.js';
import { useCastCheck } from '../castCheck.js';
import { useCastSubtitle } from '../castSubtitle.js';
import {
  type CastSession,
  chromeCast,
  remoteChangeEvent,
  remotePlayer,
  seekRemote,
  savedCastQuality,
  stopCasting,
} from '../cast.js';
import { clockLabel, languageLabel } from '../format.js';
import { planSummary } from '../playback.js';
import { Icon } from './Icon.js';
import { NextEpisode } from './NextEpisode.js';

const HEARTBEAT_MS = 20_000;
const REPORT_MS = 10_000;
const SEEK_STEP = 10;
/** Seeks this close stay in the session; further away a new session starts there. */
const NEAR = 30;

interface Started {
  token: number;
  /** `at`: when the TV got it (for "nothing fetched yet"). */
  session?: { id: string; start: number; at: number };
  queue?: number;
  error?: string;
}

interface Remote {
  time: number;
  paused: boolean;
  state: string | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The receiver's position and state, and play/pause and seek on it. */
function useRemote(): {
  remote: Remote;
  controls?: { playOrPause: () => void; seekTo: (seconds: number) => void };
} {
  const [handles] = useState(() => {
    try {
      return remotePlayer();
    } catch {
      return undefined;
    }
  });
  const [remote, setRemote] = useState<Remote>({ time: 0, paused: false, state: null });
  useEffect(() => {
    if (!handles) return;
    const { player, controller } = handles;
    const onChange = () =>
      setRemote({ time: player.currentTime, paused: player.isPaused, state: player.playerState });
    const type = remoteChangeEvent();
    controller.addEventListener(type, onChange);
    return () => controller.removeEventListener(type, onChange);
  }, [handles]);
  const controls = useMemo(
    () =>
      handles && {
        playOrPause: () => handles.controller.playOrPause(),
        seekTo: (seconds: number) => seekRemote(handles, seconds),
      },
    [handles],
  );
  return { remote, ...(controls && { controls }) };
}

export function CastView({
  session: castSession,
  device,
  context,
  startAt,
  quality,
  audioTrack,
  subtitle,
  subtitles,
  onSubtitle,
  intro,
  title,
  line,
  backTo,
  onPosition,
  onPlayNext,
}: {
  session: CastSession;
  device: string | undefined;
  context: FileContext;
  /** Where to start, in seconds from the start of the file (read once). */
  startAt: () => number;
  quality: Quality;
  audioTrack: number | undefined;
  /** The subtitle to show on the TV, with its shift; loaded again when it changes. */
  subtitle: { option: SubtitleOption; shiftMs: number } | undefined;
  /** What the file has, and choosing one ("Ondertitels op de tv"). */
  subtitles: SubtitleOption[];
  onSubtitle: (id: string | null) => void;
  intro: IntroInfo;
  title: string;
  line?: string | undefined;
  backTo: string;
  /** The position in the file: for going on in the browser after casting. */
  onPosition: (seconds: number) => void;
  onPlayNext: () => void;
}) {
  const { file, item, episode, next } = context;
  const duration = (file.durationMs ?? 0) / 1000;
  const { remote, controls } = useRemote();

  const [request, setRequest] = useState(() => ({ start: startAt(), token: 0 }));
  const [started, setStarted] = useState<Started>();
  const current = started?.token === request.token ? started : undefined;
  const session = current?.session;
  const position = (session?.start ?? request.start) + (session ? remote.time : 0);
  const [scrub, setScrub] = useState<number>();

  // The TV couldn't play the 4K stream: 1080p H.264 for the rest of this cast.
  const [hd, setHd] = useState(false);
  const plan = useMemo(() => {
    const model = castSession.getCastDevice().modelName;
    return planPlayback(file, castDevice(model, hd ? '1080p' : savedCastQuality()), {
      quality,
      noDirect: true,
      ...(audioTrack !== undefined && { audioTrack }),
    });
  }, [castSession, file, quality, audioTrack, hd]);
  const planKey = JSON.stringify(plan);

  // What the receiver loads; reads the latest subtitle when a session starts.
  const loadRequest = useEffectEvent(
    (link: { playlistUrl: string; posterUrl: string; subtitleUrl: string }, start: number) => {
      const chrome = chromeCast();
      const media = chrome.media;
      const info = new media.MediaInfo(link.playlistUrl, 'application/x-mpegurl');
      info.streamType = media.StreamType.BUFFERED;
      if (media.HlsSegmentFormat) info.hlsSegmentFormat = media.HlsSegmentFormat.FMP4;
      if (media.HlsVideoSegmentFormat)
        info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.FMP4;
      if (duration > 0) info.duration = Math.max(0, duration - start);
      const metadata = episode ? new media.TvShowMediaMetadata() : new media.MovieMediaMetadata();
      if (episode) {
        metadata.seriesTitle = item.title;
        metadata.title = episode.title ?? `Aflevering ${episode.episodeNumber}`;
        metadata.season = episode.seasonNumber;
        metadata.episode = episode.episodeNumber;
      } else {
        metadata.title = item.title;
      }
      metadata.images = [new chrome.Image(link.posterUrl)];
      info.metadata = metadata;
      const tracks: Record<string, unknown>[] = [];
      if (subtitle?.option.url) {
        const shiftMs = Math.round(subtitle.shiftMs - start * 1000);
        const track = new media.Track(1, media.TrackType.TEXT);
        track.trackContentId = castSubtitleUrl(link.subtitleUrl, subtitle.option.id, shiftMs);
        track.trackContentType = 'text/vtt';
        track.subtype = media.TextTrackType.SUBTITLES;
        track.name = subtitle.option.label ?? languageLabel(subtitle.option.language);
        const language = languageCode1(subtitle.option.language);
        if (language) track.language = language;
        tracks.push(track);
      }
      info.tracks = tracks;
      const load = new media.LoadRequest(info);
      load.autoplay = true;
      load.currentTime = 0;
      if (tracks.length > 0) load.activeTrackIds = [1];
      return { load, subtitleId: tracks.length > 0 ? subtitle?.option.id : undefined };
    },
  );

  // What the receiver has now: a subtitle that becomes ready (an embedded
  // track read whole), or another choice, loads the same session again there.
  const loaded = useRef<{
    session: string;
    link: { playlistUrl: string; posterUrl: string; subtitleUrl: string };
    start: number;
    subtitle: string | undefined;
  }>(undefined);

  // A session for the Chromecast, loaded on the receiver.
  useEffect(() => {
    const current = JSON.parse(planKey) as typeof plan;
    if (current.mode !== 'remux' && current.mode !== 'transcode') return;
    const token = request.token;
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        let playback = await api.startPlayback({
          fileId: file.id,
          start: request.start,
          video: current.video,
          ...(current.audio && { audio: current.audio, audioTrack: current.audioTrack }),
        });
        // Replaced (a seek, a retry) before the TV got it: nobody stops it otherwise.
        const abandon = () => void api.stopPlayback(playback.id).catch(() => {});
        while (!cancelled && playback.status === 'queued') {
          setStarted({ token, ...(playback.queuePosition && { queue: playback.queuePosition }) });
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          if (!cancelled) playback = await api.playbackSession(playback.id);
        }
        if (cancelled) return abandon();
        if (playback.status === 'failed')
          throw new Error(playback.error ?? 'het omzetten is mislukt');
        const link = await api.castLink(file.id, playback.id);
        if (cancelled) return abandon();
        const { load, subtitleId } = loadRequest(link, playback.start);
        loaded.current = {
          session: playback.id,
          link,
          start: playback.start,
          subtitle: subtitleId,
        };
        const refused = await castSession.loadMedia(load);
        if (refused) throw new Error(`de Chromecast laadt de video niet (${String(refused)})`);
        // On the TV now: it goes on, also when this page closes.
        if (cancelled) return;
        setStarted({ token, session: { id: playback.id, start: playback.start, at: Date.now() } });
        const id = playback.id;
        // The receiver fetches segments while it plays; this keeps a paused session.
        heartbeat = setInterval(() => void api.playbackSession(id).catch(() => {}), HEARTBEAT_MS);
      } catch (error) {
        if (!cancelled) setStarted({ token, error: message(error) });
      }
    })();
    return () => {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      // Not stopped here: the TV goes on when the page closes. A seek or
      // "Stoppen met casten" stops it.
    };
  }, [castSession, file.id, planKey, request]);

  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
    onPosition(position);
  }, [position, onPosition]);

  // Progress for "Verder kijken", as the browser's own player reports it.
  useEffect(() => {
    if (!session) return;
    const report = () =>
      void api
        .reportProgress(
          file.id,
          Math.round(positionRef.current * 1000),
          file.durationMs || undefined,
        )
        .catch(() => {});
    const timer = setInterval(report, REPORT_MS);
    return () => {
      clearInterval(timer);
      report();
    };
  }, [file.durationMs, file.id, session]);

  // The end of the file (not of a session that stopped early): it played, and is idle near the end.
  const [playedFor, setPlayedFor] = useState<string>();
  useEffect(() => {
    if (session && remote.state === 'PLAYING' && playedFor !== session.id) {
      const timer = setTimeout(() => setPlayedFor(session.id), 0);
      return () => clearTimeout(timer);
    }
  }, [session, remote.state, playedFor]);
  const ended =
    session !== undefined &&
    playedFor === session.id &&
    remote.state === 'IDLE' &&
    (duration === 0 || position >= duration - 60);

  function seek(target: number) {
    const to = Math.min(Math.max(0, target), Math.max(0, duration - 1));
    if (
      session &&
      controls &&
      to >= session.start &&
      to <= position + NEAR &&
      to >= position - 600
    ) {
      controls.seekTo(to - session.start);
      return;
    }
    if (session) void api.stopPlayback(session.id).catch(() => {});
    setRequest((r) => ({ start: to, token: r.token + 1 }));
  }

  function stop() {
    if (session) void api.stopPlayback(session.id).catch(() => {});
    stopCasting();
  }

  const playing = remote.state === 'PLAYING' || remote.state === 'BUFFERING';
  // Why it doesn't play (from what the TV fetched); 4K that fails goes to 1080p once.
  const receiverError = castSession.getMediaSession()?.idleReason === 'ERROR';
  const problem = useCastCheck(session, receiverError, playing);

  // The subtitle on the TV: made ready on the server, then loaded at the same place.
  const castSubtitle = useCastSubtitle(file.id, subtitle?.option, Boolean(session));
  const readySubtitle = subtitle?.option.url ? subtitle.option.id : undefined;
  const reload = useEffectEvent(() => {
    const now = loaded.current;
    if (!session || !now || now.session !== session.id || now.subtitle === readySubtitle) return;
    const { load, subtitleId } = loadRequest(now.link, now.start);
    now.subtitle = subtitleId;
    load.autoplay = playing;
    load.currentTime = Math.max(0, position - now.start);
    void castSession.loadMedia(load).catch(() => {});
  });
  useEffect(() => reload(), [readySubtitle, session?.id]);
  const choices = castSubtitleChoices(subtitles);
  const retryHd = Boolean(
    problem?.retryHd &&
    !hd &&
    session &&
    castIs4k(castSession.getCastDevice().modelName, savedCastQuality()),
  );
  useEffect(() => {
    if (!retryHd || !session) return;
    const timer = setTimeout(() => {
      void api.stopPlayback(session.id).catch(() => {});
      setHd(true);
      setRequest((r) => ({ start: position, token: r.token + 1 }));
    }, 0);
    return () => clearTimeout(timer);
  }, [retryHd]); // eslint-disable-line react-hooks/exhaustive-deps
  const unplayable = plan.mode !== 'remux' && plan.mode !== 'transcode';
  const state = unplayable
    ? `Deze Chromecast kan dit bestand niet afspelen. ${planSummary(plan)}.`
    : current?.error
      ? `Casten lukt niet: ${current.error}.`
      : problem && !retryHd
        ? `Casten lukt niet. ${problem.text}`
        : hd && !session
          ? 'In 4K lukte het niet; nu in 1080p…'
          : !session
            ? current?.queue
              ? `In de wachtrij: plek ${current.queue}`
              : 'Bezig met starten…'
            : remote.state === 'BUFFERING'
              ? 'Laden…'
              : undefined;
  const time = scrub ?? position;
  const commit = () => {
    if (scrub === undefined) return;
    setScrub(undefined);
    seek(scrub);
  };
  // Intro, recap, preview, or (without a next episode) to the scene after the credits.
  const skip = skipChoice(intro, position, duration, Boolean(next));
  const nextAtCredits = Boolean(next && intro.credits && inCredits(intro.credits, position));
  // What this profile skips by itself, once per part.
  const autoSkipped = useRef(new Set<string>());
  const action = autoSkip(intro, position, duration, Boolean(next), context.skip, NONE);
  useEffect(() => {
    if (!action || autoSkipped.current.has(action.key)) return;
    autoSkipped.current.add(action.key);
    const { next: toNext, to } = action;
    // Out of the effect: seeking starts a new stream (state).
    const timer = setTimeout(() => (toNext ? onPlayNext() : to !== undefined && seek(to)), 0);
    return () => clearTimeout(timer);
  }, [action?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const backdrop = item.backdropUrl ?? item.posterUrl;

  return (
    <div className="cast-view" aria-label="Casten">
      {backdrop && <img className="cast-backdrop" src={backdrop} alt="" />}
      <div className="player-top">
        <Link to={backTo} className="icon-button player-back" aria-label="Terug naar de titel">
          <Icon name="back" />
        </Link>
        <div className="player-heading">
          <span className="player-title">{title}</span>
          {line && <span className="player-subtitle">{line}</span>}
        </div>
      </div>

      <div className="cast-middle">
        <Icon name="cast" size={44} />
        <p className="cast-device">
          {device ? `Speelt af op ${device}` : 'Verbonden met de Chromecast'}
        </p>
        {state && (
          <p className="muted" role="status">
            {state}
          </p>
        )}
        {(castSubtitle.note || castSubtitle.error) && (
          <p className="muted" role="status">
            {castSubtitle.error ?? castSubtitle.note}
          </p>
        )}
        {(current?.error || (problem && !retryHd)) && (
          <button
            type="button"
            className="button primary"
            onClick={() => setRequest((r) => ({ start: position, token: r.token + 1 }))}
          >
            Opnieuw proberen
          </button>
        )}
      </div>

      <div className="cast-controls">
        <div className="cast-timeline">
          <span className="time">{clockLabel(time)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.floor(duration))}
            step={1}
            value={Math.floor(time)}
            aria-label="Tijdlijn"
            aria-valuetext={clockLabel(time)}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
          />
          <span className="time">-{clockLabel(Math.max(0, duration - time))}</span>
        </div>
        <div className="cast-buttons">
          <button
            type="button"
            className="icon-button"
            aria-label="10 seconden terug"
            onClick={() => seek(position - SEEK_STEP)}
          >
            <Icon name="replay10" />
          </button>
          <button
            type="button"
            className="icon-button large"
            aria-label={playing ? 'Pauze' : 'Afspelen'}
            disabled={!session}
            onClick={() => controls?.playOrPause()}
          >
            <Icon name={playing ? 'pause' : 'play'} size={36} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="10 seconden vooruit"
            onClick={() => seek(position + SEEK_STEP)}
          >
            <Icon name="forward10" />
          </button>
        </div>
        <div className="cast-actions">
          {skip && (
            <button type="button" className="button secondary" onClick={() => seek(skip.to)}>
              <Icon name="next" /> {skip.label}
            </button>
          )}
          {next && nextAtCredits && !ended && (
            <button type="button" className="button secondary" onClick={onPlayNext}>
              <Icon name="next" /> Volgende aflevering
            </button>
          )}
          {choices.length > 0 && (
            <label className="cast-subtitles">
              <Icon name="subtitles" />
              <select
                aria-label="Ondertitels op de tv"
                value={subtitle?.option.id ?? ''}
                onChange={(event) => onSubtitle(event.target.value || null)}
              >
                <option value="">Ondertitels uit</option>
                {choices.map((option) => (
                  <option key={option.id} value={option.id}>
                    {[
                      option.language ? languageLabel(option.language) : 'Onbekende taal',
                      option.label,
                      option.forced ? 'alleen vreemde taal' : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="button secondary" onClick={stop}>
            <Icon name="close" /> Stoppen met casten
          </button>
        </div>
      </div>

      {ended && next && (
        <NextEpisode next={next} onPlay={onPlayNext} cancelLabel="Stoppen" onCancel={stop} />
      )}
    </div>
  );
}
