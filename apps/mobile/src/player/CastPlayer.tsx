// Playing on a Chromecast. The phone starts an HLS session on the transcoder
// (sized and converted for the Chromecast, castDevice in packages/shared),
// asks the API for a cast link, and has the Default Media Receiver load it.
// The phone then is the remote: play, pause, seek, stop. A session starts
// somewhere in the file, so the position is the session's start plus the
// receiver's position, as in the phone's own player.

import {
  castDevice,
  castSubtitleChoices,
  castSubtitleUrl,
  castIs4k,
  type FileContext,
  inCredits,
  type IntroInfo,
  type IntroRange,
  languageCode1,
  planPlayback,
  type Quality,
  type SkipSettings,
  type SubtitleOption,
  skipChoice,
} from '@cinevault/shared';
import Slider from '@react-native-community/slider';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  CastContext,
  MediaHlsSegmentFormat,
  MediaHlsVideoSegmentFormat,
  type MediaInfo,
  MediaPlayerIdleReason,
  MediaPlayerState,
  MediaStreamType,
  type MediaTrack,
  type RemoteMediaClient,
  useCastDevice,
  useMediaStatus,
  useStreamPosition,
} from 'react-native-google-cast';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CastIcon } from '../components/CastIcon';
import { Icon } from '../components/Icon';
import { Button, IconButton, ServerImage } from '../components/ui';
import { clockLabel, languageLabel } from '../format';
import { useCastQualitySetting } from '../preferences';
import { useSession } from '../session';
import { useCastCheck } from './castCheck';
import { useCastSubtitle } from './castSubtitle';
import { useAutoSkip } from './skip';
import { colors, radius } from '../theme';
import { planText } from './summary';

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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function subtitleName(option: SubtitleOption): string {
  return [
    option.language ? languageLabel(option.language) : 'Onbekende taal',
    option.label,
    option.forced ? 'alleen vreemde taal' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function CastPlayer({
  client,
  context,
  startAt,
  quality,
  audioTrack,
  subtitle,
  subtitles,
  onSubtitle,
  title,
  line,
  onPosition,
  onEnded,
  onBack,
  ended,
  countdown,
  onPlayNext,
  intro,
  credits,
  creditsSource,
  moreCredits,
  recap,
  preview,
  skip: skipSettings,
}: {
  client: RemoteMediaClient;
  context: FileContext;
  /** Where to start, in seconds from the start of the file (read once). */
  startAt: () => number;
  quality: Quality;
  audioTrack: number | undefined;
  /** The subtitle to show on the TV, with its shift; loaded again when it changes. */
  subtitle: { option: SubtitleOption; shiftMs: number } | undefined;
  /** What the file has, and choosing one ("Ondertitels" while casting). */
  subtitles: SubtitleOption[];
  onSubtitle: (id: string | null) => void;
  title: string;
  line?: string;
  /** The position in the file, for progress and for going on on the phone. */
  onPosition: (seconds: number) => void;
  onEnded: () => void;
  onBack: () => void;
  ended: boolean;
  countdown: number;
  onPlayNext: () => void;
  /** Skip Intro: the TV plays it, the phone has the button. */
  intro?: IntroRange;
  /** The end credits: the phone offers the next episode (or skips to a scene after them). */
  credits?: IntroRange;
  /** A film's credits ("picture"), and the parts after a scene: skipped one by one. */
  creditsSource?: IntroInfo['creditsSource'];
  moreCredits?: IntroRange[];
  /** The recap ("Previously on…"): the phone has a button to skip it. */
  recap?: IntroRange;
  /** The preview of the next episode, near the end: a button too. */
  preview?: IntroRange;
  /** What this profile skips by itself. */
  skip?: SkipSettings;
}) {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const { file, item, episode, next } = context;
  const duration = (file.durationMs ?? 0) / 1000;
  const device = useCastDevice();
  const [castQuality] = useCastQualitySetting();
  const status = useMediaStatus();
  const streamPosition = useStreamPosition(1);

  const [request, setRequest] = useState(() => ({ start: startAt(), token: 0 }));
  const [started, setStarted] = useState<Started>();
  const current = started?.token === request.token ? started : undefined;
  const session = current?.session;
  const position = (session?.start ?? request.start) + (session ? (streamPosition ?? 0) : 0);
  const [scrub, setScrub] = useState<number>();

  // The TV couldn't play the 4K stream: 1080p H.264 for the rest of this cast.
  const [hd, setHd] = useState(false);
  const plan = useMemo(
    () =>
      planPlayback(file, castDevice(device?.modelName, hd ? '1080p' : castQuality), {
        quality,
        noDirect: true,
        ...(audioTrack !== undefined && { audioTrack }),
      }),
    [file, device?.modelName, castQuality, hd, quality, audioTrack],
  );
  const planKey = JSON.stringify(plan);

  // What the receiver loads; reads the latest subtitle when a session starts.
  const mediaInfo = useEffectEvent(
    (link: { playlistUrl: string; posterUrl: string; subtitleUrl: string }, start: number) => {
      const tracks: MediaTrack[] = [];
      if (subtitle?.option.url) {
        const shiftMs = Math.round(subtitle.shiftMs - start * 1000);
        tracks.push({
          id: 1,
          type: 'text',
          subtype: 'subtitles',
          contentId: castSubtitleUrl(link.subtitleUrl, subtitle.option.id, shiftMs),
          contentType: 'text/vtt',
          name: subtitle.option.label ?? languageLabel(subtitle.option.language),
          ...(languageCode1(subtitle.option.language) && {
            language: languageCode1(subtitle.option.language),
          }),
        });
      }
      const images = [{ url: link.posterUrl }];
      const info: MediaInfo = {
        contentUrl: link.playlistUrl,
        contentType: 'application/x-mpegURL',
        streamType: MediaStreamType.BUFFERED,
        hlsSegmentFormat: MediaHlsSegmentFormat.FMP4,
        hlsVideoSegmentFormat: MediaHlsVideoSegmentFormat.FMP4,
        ...(duration > 0 && { streamDuration: Math.max(0, duration - start) }),
        mediaTracks: tracks,
        metadata: episode
          ? {
              type: 'tvShow',
              seriesTitle: item.title,
              title: episode.title ?? `Aflevering ${episode.episodeNumber}`,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
              images,
            }
          : { type: 'movie', title: item.title, images },
      };
      return { info, subtitles: tracks.length > 0, subtitleId: subtitle?.option.id };
    },
  );

  // What the receiver has now: a subtitle that becomes ready (an embedded
  // track read whole), or another choice, loads the same session again there.
  const loaded = useRef<{
    session: string;
    link: { playlistUrl: string; posterUrl: string; subtitleUrl: string };
    start: number;
    subtitle?: string;
  }>(undefined);

  // What plays stays on its address, as in the phone's own player.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  // A session for the Chromecast, loaded on the receiver.
  useEffect(() => {
    if (!device) return;
    const api = apiRef.current;
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
          setStarted({
            token,
            ...(playback.queuePosition && { queue: playback.queuePosition }),
          });
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          if (!cancelled) playback = await api.playbackSession(playback.id);
        }
        if (cancelled) return abandon();
        if (playback.status === 'failed')
          throw new Error(playback.error ?? 'het omzetten is mislukt');
        const link = await api.castLink(file.id, playback.id);
        if (cancelled) return abandon();
        const { info, subtitles, subtitleId } = mediaInfo(link, playback.start);
        loaded.current = {
          session: playback.id,
          link,
          start: playback.start,
          ...(subtitles && { subtitle: subtitleId }),
        };
        await client.loadMedia({
          mediaInfo: info,
          autoplay: true,
          startTime: 0,
          ...(subtitles && { activeTrackIds: [1] }),
        });
        // On the TV now: it goes on, also when the phone leaves the player.
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
      // The session is not stopped here: the TV goes on when the phone leaves
      // the player. A seek or "Stoppen" stops it.
    };
  }, [client, device, file.id, planKey, request]);

  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
    onPosition(position);
  }, [position, onPosition]);

  // Progress for "Verder kijken", as the phone's own player reports it.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      void api
        .reportProgress(
          file.id,
          Math.round(positionRef.current * 1000),
          file.durationMs || undefined,
        )
        .catch(() => {});
    }, REPORT_MS);
    return () => clearInterval(timer);
  }, [api, file.durationMs, file.id, session]);

  // The end of the file (not of a session that stopped early).
  const endedFor = useRef<string | undefined>(undefined);
  const finished =
    status?.playerState === MediaPlayerState.IDLE &&
    status.idleReason === MediaPlayerIdleReason.FINISHED &&
    session !== undefined &&
    (duration === 0 || position >= duration - 60);
  useEffect(() => {
    if (!finished || !session || endedFor.current === session.id) return;
    endedFor.current = session.id;
    onEnded();
  }, [finished, session, onEnded]);

  function seek(target: number) {
    const to = Math.min(Math.max(0, target), Math.max(0, duration - 1));
    if (session && to >= session.start && to <= position + NEAR && to >= position - 600) {
      void client.seek({ position: to - session.start });
      return;
    }
    if (session) void api.stopPlayback(session.id).catch(() => {});
    setRequest((r) => ({ start: to, token: r.token + 1 }));
  }

  // The parts, and what this profile skips by itself (once per part).
  const parts = { intro, recap, credits, creditsSource, moreCredits, preview };
  useAutoSkip(parts, position, duration, Boolean(next), skipSettings, {
    seek,
    playNext: onPlayNext,
  });

  function stopCasting() {
    if (session) void api.stopPlayback(session.id).catch(() => {});
    void CastContext.getSessionManager().endCurrentSession(true);
  }

  const playing =
    status?.playerState === MediaPlayerState.PLAYING ||
    status?.playerState === MediaPlayerState.BUFFERING;
  // Why it doesn't play (from what the TV fetched); 4K that fails goes to 1080p once.
  const receiverError =
    status?.playerState === MediaPlayerState.IDLE &&
    status.idleReason === MediaPlayerIdleReason.ERROR;
  const problem = useCastCheck(session, receiverError, playing);

  // The subtitle on the TV: made ready on the server, then loaded at the same place.
  const castSubtitle = useCastSubtitle(file.id, subtitle?.option, Boolean(session));
  const readySubtitle = subtitle?.option.url ? subtitle.option.id : undefined;
  const reload = useEffectEvent(() => {
    const now = loaded.current;
    if (!session || !now || now.session !== session.id || now.subtitle === readySubtitle) return;
    const { info, subtitles: withTrack, subtitleId } = mediaInfo(now.link, now.start);
    now.subtitle = withTrack ? subtitleId : undefined;
    void client
      .loadMedia({
        mediaInfo: info,
        autoplay: playing,
        startTime: Math.max(0, position - now.start),
        ...(withTrack && { activeTrackIds: [1] }),
      })
      .catch(() => {});
  });
  useEffect(() => reload(), [readySubtitle, session?.id]);
  const [picking, setPicking] = useState(false);
  const choices = castSubtitleChoices(subtitles);
  const retryHd = Boolean(
    problem?.retryHd && !hd && castIs4k(device?.modelName, castQuality) && session,
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
    ? `Deze Chromecast kan dit bestand niet afspelen. ${planText(plan)}`
    : current?.error
      ? `Casten lukt niet: ${current.error}`
      : problem && !retryHd
        ? `Casten lukt niet. ${problem.text}`
        : !device || !session
          ? current?.queue
            ? `In de wachtrij: plek ${current.queue}`
            : 'Bezig met starten…'
          : status?.playerState === MediaPlayerState.BUFFERING ||
              status?.playerState === MediaPlayerState.LOADING
            ? 'Laden…'
            : undefined;
  const time = scrub ?? position;
  const pad = { paddingLeft: Math.max(insets.left, 24), paddingRight: Math.max(insets.right, 24) };

  // Intro, recap, preview, or (no next episode) to the scene after the credits.
  const skip = skipChoice(parts, position, duration, Boolean(next));
  return (
    <View style={styles.stage}>
      <ServerImage path={item.backdropUrl ?? item.posterUrl} style={StyleSheet.absoluteFill} />
      <View style={styles.dim} />

      <View style={[styles.top, pad]}>
        <IconButton icon="back" label="Terug" onPress={onBack} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {line ? (
            <Text style={styles.line} numberOfLines={1}>
              {line}
            </Text>
          ) : null}
        </View>
        <CastIcon />
      </View>

      <View style={styles.middle} pointerEvents="box-none">
        <Icon name="cast" size={40} color={colors.brass} />
        <Text style={styles.device}>
          {device ? `Speelt af op ${device.friendlyName}` : 'Verbinden met de Chromecast…'}
        </Text>
        {state ? <Text style={styles.state}>{state}</Text> : null}
        {castSubtitle.note || castSubtitle.error ? (
          <Text style={styles.state}>{castSubtitle.error ?? castSubtitle.note}</Text>
        ) : null}
        {hd && !problem ? (
          <Text style={styles.state}>In 4K lukte het niet; nu in 1080p.</Text>
        ) : null}
        {current?.error || (problem && !retryHd) ? (
          <Button
            label="Opnieuw proberen"
            onPress={() => setRequest((r) => ({ start: position, token: r.token + 1 }))}
          />
        ) : null}
      </View>

      {ended && next ? (
        <View style={styles.next}>
          <Text style={styles.eyebrow}>Volgende aflevering over {countdown} s</Text>
          <Text style={styles.nextTitle} numberOfLines={2}>
            S{next.seasonNumber}:A{next.episodeNumber}
            {next.title ? ` · ${next.title}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button label="Nu afspelen" icon="play" onPress={onPlayNext} style={{ flex: 1 }} />
            <Button label="Stoppen" kind="secondary" onPress={onBack} />
          </View>
        </View>
      ) : null}

      <View style={[styles.bottom, pad, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.timeline}>
          <Text style={styles.time}>{clockLabel(time)}</Text>
          <Slider
            style={{ flex: 1 }}
            minimumValue={0}
            maximumValue={Math.max(1, duration)}
            value={time}
            minimumTrackTintColor={colors.brass}
            maximumTrackTintColor="rgba(242,244,250,0.3)"
            thumbTintColor={colors.brass}
            onValueChange={setScrub}
            onSlidingComplete={(value) => {
              setScrub(undefined);
              seek(value);
            }}
          />
          <Text style={styles.time}>-{clockLabel(Math.max(0, duration - time))}</Text>
        </View>
        <View style={styles.buttons}>
          <IconButton
            icon="replay10"
            label="10 seconden terug"
            size={48}
            onPress={() => seek(position - SEEK_STEP)}
          />
          <IconButton
            icon={playing ? 'pause' : 'play'}
            label={playing ? 'Pauze' : 'Afspelen'}
            size={64}
            onPress={() => void (playing ? client.pause() : client.play())}
          />
          <IconButton
            icon="forward10"
            label="10 seconden vooruit"
            size={48}
            onPress={() => seek(position + SEEK_STEP)}
          />
        </View>
        {skip && skip.kind !== 'credits' && (
          <Button label={skip.label} icon="next" onPress={() => seek(skip.to)} />
        )}
        {next && credits && inCredits(credits, position) && !ended && (
          <Button label="Volgende aflevering" icon="next" onPress={onPlayNext} />
        )}
        {!ended && skip?.kind === 'credits' && (
          <Button label={skip.label} icon="next" onPress={() => seek(skip.to)} />
        )}
        {choices.length > 0 && (
          <Button
            label={`Ondertitels: ${subtitle ? subtitleName(subtitle.option) : 'Uit'}`}
            kind="secondary"
            icon="subtitles"
            onPress={() => setPicking((open) => !open)}
          />
        )}
        {picking && (
          <ScrollView style={styles.picker}>
            {[undefined, ...choices].map((option) => {
              const on = option ? subtitle?.option.id === option.id : !subtitle;
              return (
                <Pressable
                  key={option?.id ?? 'off'}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => {
                    setPicking(false);
                    onSubtitle(option?.id ?? null);
                  }}
                  style={({ pressed }) => [styles.choice, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.choiceText, on && styles.choiceOn]} numberOfLines={1}>
                    {option ? subtitleName(option) : 'Uit'}
                  </Text>
                  {on ? <Icon name="check" size={18} color={colors.brass} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        <Button label="Stoppen met casten" kind="secondary" icon="close" onPress={stopCasting} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: colors.bg },
  dim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10,18,48,0.82)',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12 },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  line: { color: colors.text2, fontSize: 14 },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  device: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  state: { color: colors.text2, fontSize: 15, textAlign: 'center' },
  bottom: { gap: 12 },
  timeline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 52 },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28 },
  next: {
    position: 'absolute',
    right: 24,
    bottom: 140,
    width: 340,
    gap: 10,
    padding: 18,
    borderRadius: radius.l,
    backgroundColor: colors.surface,
  },
  picker: {
    maxHeight: 260,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  choice: {
    minHeight: 46,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  choiceText: { flex: 1, color: colors.text, fontSize: 15 },
  choiceOn: { color: colors.brass, fontWeight: '700' },
  eyebrow: { color: colors.brass, fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  nextTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
});
