// The player's controls on a TV, for the remote:
// - hidden: left/right seek (faster while held), OK or up/down show them;
// - shown: the focus moves over the buttons, and on the timeline left/right seek;
// - the media buttons (play/pause, rewind, fast forward, next) work always;
// - back closes a panel, then hides the controls, then leaves the player.
// The seek waits until the buttons rest, so a run of presses is one seek.

import {
  canReadAsText,
  pictureSubtitleNote,
  QUALITIES,
  type SubtitleSearchResult,
} from '@cinevault/shared';
import { type Ref, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  BackHandler,
  findNodeHandle,
  type HostInstance,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Icon, type IconName } from '../components/Icon';
import { channelsLabel, clockLabel, languageLabel } from '../format';
import { FIT_LABEL, type FitMode } from '../player/fit';
import { type ControlsProps, QUALITY_LABEL, SKIP_OPTIONS, trackLabel } from '../player/Controls';
import { SeekPreview, useThumbnails } from '../player/SeekPreview';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { TvPressable } from './focus';
import { type RemoteKey, seekStep, useRemote } from './remote';
import { TV_GUTTER, TvButton } from './ui';

const HIDE_AFTER_MS = 5_000;
/** A run of seek presses closer together than this is one seek. */
const SEEK_SETTLE_MS = 800;
const REPEAT_MS = 600;
const FIT_MODES: FitMode[] = ['auto', 'fit', 'fill'];
/** As on the phone: the controls react to stopping or buffering only after a moment. */
const STOPPED_MS = 800;
const WAITING_MS = 400;

type Panel = 'none' | 'audio' | 'settings';
export type TvControlsProps = Omit<ControlsProps, 'onPinch'>;

function Choice({
  label,
  on,
  onPress,
  disabled,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TvPressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on, disabled: Boolean(disabled) }}
      disabled={disabled}
      autoFocus={on}
      onPress={onPress}
      style={[
        styles.choice,
        on && { backgroundColor: colors.brassSoft },
        disabled && { opacity: 0.45 },
      ]}
      focusStyle={styles.choiceFocused}
    >
      <View style={[styles.radio, on && styles.radioOn]} />
      <Text style={styles.choiceText}>{label}</Text>
    </TvPressable>
  );
}

function SubtitleSearch({
  fileId,
  onAdded,
}: {
  fileId: string;
  onAdded: ControlsProps['cues']['added'];
}) {
  const { api } = useSession();
  const [results, setResults] = useState<SubtitleSearchResult[]>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function search() {
    setBusy('search');
    setError(undefined);
    try {
      setResults(await api.searchSubtitles(fileId, ['nld', 'eng']));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function download(result: SubtitleSearchResult) {
    setBusy(result.id);
    setError(undefined);
    try {
      onAdded(await api.downloadSubtitle(fileId, result.id));
      setResults(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <View style={{ gap: 6 }}>
      {!results && (
        <TvButton
          label={busy === 'search' ? 'Zoeken…' : 'Zoeken op OpenSubtitles'}
          icon="search"
          disabled={busy !== undefined}
          onPress={() => void search()}
        />
      )}
      {results?.length === 0 && <Text style={styles.muted}>Niets gevonden.</Text>}
      {results?.slice(0, 12).map((result, index) => (
        <TvPressable
          key={result.id}
          accessibilityRole="button"
          disabled={busy !== undefined}
          autoFocus={index === 0}
          onPress={() => void download(result)}
          style={styles.result}
          focusStyle={styles.choiceFocused}
        >
          <Text style={styles.choiceText} numberOfLines={2}>
            <Text style={{ fontWeight: '700' }}>
              {result.language ? languageLabel(result.language) : '?'}
            </Text>{' '}
            {result.release}
          </Text>
          <Text style={styles.small}>
            {result.downloads.toLocaleString('nl-NL')} downloads
            {result.matchesFile ? ' · past bij dit bestand' : ''}
            {busy === result.id ? ' · bezig…' : ''}
          </Text>
        </TvPressable>
      ))}
      {error && <Text style={{ color: colors.danger }}>{error}</Text>}
    </View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
  autoFocus,
  ref,
  onLayout,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  autoFocus?: boolean;
  ref?: Ref<HostInstance | null>;
  onLayout?: () => void;
}) {
  return (
    <TvPressable
      ref={ref}
      onLayout={onLayout}
      accessibilityRole="button"
      accessibilityLabel={label}
      autoFocus={autoFocus}
      onPress={onPress}
      style={styles.round}
      focusStyle={styles.roundFocused}
    >
      {({ focused }) => <Icon name={icon} size={28} color={focused ? colors.ink : colors.text} />}
    </TvPressable>
  );
}

export function TvControls({
  player,
  title,
  subtitle,
  position,
  duration,
  playing,
  buffering,
  onSeek,
  onBack,
  fitMode,
  onFitMode,
  quality,
  onQuality,
  tracks,
  audioTrack,
  onAudioTrack,
  cues,
  fileId,
  summary,
  phase,
  resumedAt,
  onRestart,
  next,
  ended,
  countdown,
  onPlayNext,
  onSkipIntro,
  skipLabel = 'Intro overslaan',
  skipFresh = true,
  onWatchCredits,
  skipSettings,
  onSkipSettings,
}: TvControlsProps) {
  const [visible, setVisible] = useState(true);
  const [panel, setPanel] = useState<Panel>('none');
  const [target, setTarget] = useState<number>();
  // Seeking: a picture of the target above the timeline, once the server made them.
  const thumbnails = useThumbnails(fileId);
  const [trackWidth, setTrackWidth] = useState(0);
  const [resumeNotice, setResumeNotice] = useState(resumedAt > 0);
  const [userPaused, setUserPaused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [onTimeline, setOnTimeline] = useState(false);
  const [timelineTag, setTimelineTag] = useState<number>();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const run = useRef<{ direction: number; at: number; count: number }>({
    direction: 0,
    at: 0,
    count: 0,
  });
  const timeline = useRef<HostInstance | null>(null);
  // Down from the timeline: play/pause. Android's search would take the button
  // nearest the middle of the screen (the timeline is as wide as the screen).
  const playButton = useRef<HostInstance | null>(null);
  const [playTag, setPlayTag] = useState<number>();

  useEffect(() => {
    const timer = setTimeout(
      () => {
        setStopped(!playing);
        if (playing) setUserPaused(false);
      },
      playing ? 0 : STOPPED_MS,
    );
    return () => clearTimeout(timer);
  }, [playing]);

  useEffect(() => {
    const timer = setTimeout(() => setWaiting(buffering), buffering ? WAITING_MS : 0);
    return () => clearTimeout(timer);
  }, [buffering]);

  useEffect(() => {
    if (!resumeNotice) return;
    const timer = setTimeout(() => setResumeNotice(false), 10_000);
    return () => clearTimeout(timer);
  }, [resumeNotice]);

  const paused = userPaused || (stopped && !playing && !waiting);
  const blocked = phase.kind === 'error' || (ended && Boolean(next));
  // Paused, a panel open or a seek under way: the controls stay.
  const shown = !blocked && panel === 'none' && (visible || paused);

  const wake = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    return () => {
      clearTimeout(hideTimer.current);
      clearTimeout(seekTimer.current);
    };
  }, []);

  function togglePlay(force?: 'play' | 'pause') {
    const play = force ? force === 'play' : paused;
    if (play) {
      setUserPaused(false);
      setStopped(false);
      player.play();
    } else {
      setUserPaused(true);
      player.pause();
    }
    wake();
  }

  /** One press of a seek button: the target moves, the seek follows when the presses stop. */
  function seekBy(direction: 1 | -1) {
    const now = Date.now();
    const last = run.current;
    const count = last.direction === direction && now - last.at < REPEAT_MS ? last.count + 1 : 0;
    run.current = { direction, at: now, count };
    const from = target ?? position;
    const to = Math.min(Math.max(0, from + direction * seekStep(count)), Math.max(0, duration - 1));
    setTarget(to);
    clearTimeout(seekTimer.current);
    seekTimer.current = setTimeout(() => {
      setTarget(undefined);
      onSeek(to);
    }, SEEK_SETTLE_MS);
    if (shown) wake();
  }

  function onKey(key: RemoteKey) {
    switch (key) {
      case 'playPause':
        togglePlay();
        return;
      case 'play':
      case 'pause':
        togglePlay(key);
        return;
      case 'rewind':
        seekBy(-1);
        return;
      case 'fastForward':
        seekBy(1);
        return;
      case 'next':
        if (next) onPlayNext();
        return;
      case 'stop':
        onBack();
        return;
      default:
        break;
    }
    if (blocked || panel !== 'none') return;
    if (!shown) {
      // OK reaches the invisible surface (its onPress); the arrows are ours.
      if (key === 'left' || key === 'right') seekBy(key === 'left' ? -1 : 1);
      else if (key === 'up' || key === 'down' || key === 'menu' || key === 'info') wake();
      return;
    }
    if (onTimeline && (key === 'left' || key === 'right')) seekBy(key === 'left' ? -1 : 1);
    else wake();
  }
  useRemote(onKey);

  // Back: a panel first, then the controls, then the player (the screen's own back).
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel !== 'none') {
        setPanel('none');
        wake();
        return true;
      }
      if (shown && !paused && !ended) {
        clearTimeout(hideTimer.current);
        setVisible(false);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [panel, shown, paused, ended, wake]);

  const time = target ?? position;
  const trackLayout = (event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width);
  const preview =
    thumbnails && target !== undefined && trackWidth > 0 ? (
      <SeekPreview
        thumbnails={thumbnails}
        time={target}
        center={(target / Math.max(1, duration)) * trackWidth}
        bounds={trackWidth}
        width={320}
      />
    ) : null;
  const share = duration > 0 ? Math.min(1, time / duration) : 0;

  return (
    <View style={StyleSheet.absoluteFill}>
      {!shown && panel === 'none' && !blocked && (
        // Holds the focus while the controls are hidden, so the remote's keys arrive.
        <TvPressable
          autoFocus
          accessibilityLabel={onSkipIntro && skipFresh ? skipLabel : 'Bediening tonen'}
          // While the button shows (its first 8 s), OK skips, as it says; then OK shows the
          // controls, with the button in the row.
          onPress={(skipFresh ? onSkipIntro : undefined) ?? wake}
          style={StyleSheet.absoluteFill}
          focusStyle={{}}
        />
      )}

      {onSkipIntro &&
        skipFresh &&
        !shown &&
        panel === 'none' &&
        !blocked &&
        target === undefined && (
          <View style={styles.skip} pointerEvents="none">
            <Text style={styles.skipText}>{skipLabel}</Text>
            <View style={styles.okKey}>
              <Text style={styles.okText}>OK</Text>
            </View>
          </View>
        )}

      {waiting && !ended && phase.kind !== 'error' && phase.kind !== 'queued' && (
        <ActivityIndicator
          size="large"
          color={colors.brass}
          style={styles.spinner}
          pointerEvents="none"
        />
      )}

      {/* A seek while the controls are hidden: just the timeline. */}
      {!shown && target !== undefined && (
        <View style={[styles.bottom, styles.seekOnly]} pointerEvents="none">
          <View style={styles.timelineRow}>
            <Text style={styles.time}>{clockLabel(time)}</Text>
            <View style={styles.track} onLayout={trackLayout}>
              <View style={[styles.fill, { width: `${share * 100}%` }]} />
              {preview}
            </View>
            <Text style={styles.time}>-{clockLabel(Math.max(0, duration - time))}</Text>
          </View>
        </View>
      )}

      {shown && (
        <>
          <View style={styles.top} pointerEvents="none">
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>

          <View style={styles.bottom}>
            <TvPressable
              ref={timeline}
              accessibilityLabel={`Positie ${clockLabel(time)} van ${clockLabel(duration)}, links en rechts om te spoelen`}
              onLayout={() => setTimelineTag(findNodeHandle(timeline.current) ?? undefined)}
              // Left and right stay here: they seek.
              {...(timelineTag !== undefined && {
                nextFocusLeft: timelineTag,
                nextFocusRight: timelineTag,
              })}
              {...(playTag !== undefined && { nextFocusDown: playTag })}
              onFocus={() => setOnTimeline(true)}
              onBlur={() => setOnTimeline(false)}
              style={styles.timeline}
              focusStyle={styles.timelineFocused}
            >
              {({ focused }) => (
                <View style={styles.timelineRow}>
                  <Text style={styles.time}>{clockLabel(time)}</Text>
                  <View
                    style={[styles.track, focused && styles.trackFocused]}
                    onLayout={trackLayout}
                  >
                    <View style={[styles.fill, { width: `${share * 100}%` }]} />
                    {focused && <View style={[styles.knob, { left: `${share * 100}%` }]} />}
                    {preview}
                  </View>
                  <Text style={styles.time}>-{clockLabel(Math.max(0, duration - time))}</Text>
                </View>
              )}
            </TvPressable>
            <View style={styles.row}>
              <RoundButton icon="replay10" label="Terugspoelen" onPress={() => seekBy(-1)} />
              <RoundButton
                ref={playButton}
                onLayout={() => setPlayTag(findNodeHandle(playButton.current) ?? undefined)}
                icon={paused ? 'play' : 'pause'}
                label={paused ? 'Afspelen' : 'Pauze'}
                autoFocus
                onPress={() => togglePlay()}
              />
              <RoundButton icon="forward10" label="Vooruitspoelen" onPress={() => seekBy(1)} />
              <View style={{ flex: 1 }} />
              {onSkipIntro && (
                <TvButton
                  label={skipLabel}
                  icon="next"
                  onPress={() => {
                    onSkipIntro();
                    wake();
                  }}
                />
              )}
              {resumeNotice && (
                <TvButton
                  label={`Vanaf het begin (nu ${clockLabel(resumedAt)})`}
                  icon="replay10"
                  onPress={() => {
                    setResumeNotice(false);
                    onSeek(0);
                    wake();
                  }}
                />
              )}
              <TvButton
                label="Audio en ondertitels"
                icon="subtitles"
                onPress={() => setPanel('audio')}
              />
              <TvButton
                label={QUALITY_LABEL[quality]}
                icon="settings"
                onPress={() => setPanel('settings')}
              />
              {next && <TvButton label="Volgende" icon="next" onPress={onPlayNext} />}
            </View>
          </View>
        </>
      )}

      {phase.kind === 'queued' && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color={colors.brass} />
          <Text style={styles.overlayText}>
            In de wachtrij{phase.position ? ` (plek ${phase.position})` : ''}: de server is al met
            andere video&apos;s bezig.
          </Text>
        </View>
      )}
      {phase.kind === 'error' && (
        <View style={styles.overlay}>
          <Icon name="alert" size={36} color={colors.danger} />
          <Text style={styles.overlayText}>Afspelen lukt niet: {phase.message}.</Text>
          <Text style={styles.small}>{summary}</Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <TvButton label="Opnieuw proberen" autoFocus onPress={onRestart} />
            <TvButton label="Terug" onPress={onBack} />
          </View>
        </View>
      )}

      {ended && next && (
        <View style={styles.next}>
          <Text style={styles.eyebrow}>Volgende aflevering over {countdown} s</Text>
          <Text style={styles.nextTitle} numberOfLines={2}>
            S{next.seasonNumber}:A{next.episodeNumber}
            {next.title ? ` · ${next.title}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <TvButton label="Nu afspelen" icon="play" autoFocus onPress={onPlayNext} />
            {onWatchCredits ? (
              <TvButton label="Aftiteling bekijken" onPress={onWatchCredits} />
            ) : (
              <TvButton label="Stoppen" onPress={onBack} />
            )}
          </View>
        </View>
      )}

      {panel !== 'none' && (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>
            {panel === 'audio' ? 'Audio en ondertitels' : 'Instellingen'}
          </Text>
          <ScrollView contentContainerStyle={{ gap: 20, paddingBottom: 32, paddingTop: 4 }}>
            {panel === 'audio' ? (
              <>
                <View style={{ gap: 4 }}>
                  <Text style={styles.legend}>Audio</Text>
                  {tracks.map((track) => (
                    <Choice
                      key={track.index}
                      label={trackLabel(track)}
                      on={audioTrack === track.index}
                      onPress={() => onAudioTrack(track.index)}
                    />
                  ))}
                </View>
                <View style={{ gap: 4 }}>
                  <Text style={styles.legend}>Ondertitels</Text>
                  <Choice label="Uit" on={!cues.selected} onPress={() => cues.select(null)} />
                  {cues.options.map((option) => (
                    <Choice
                      key={option.id}
                      label={[
                        option.language ? languageLabel(option.language) : 'Onbekende taal',
                        option.label,
                        option.forced ? 'alleen vreemde taal' : undefined,
                        pictureSubtitleNote(option),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      on={cues.selected?.id === option.id}
                      disabled={!option.supported && !canReadAsText(option)}
                      // A picture subtitle: read as text first, chosen when done.
                      onPress={() =>
                        option.supported ? cues.select(option.id) : void cues.readAsText(option)
                      }
                    />
                  ))}
                  {cues.readError && (
                    <Text style={{ color: colors.danger }}>
                      Omzetten lukt niet: {cues.readError}
                    </Text>
                  )}
                  {cues.status.kind === 'reading' && (
                    <Text style={styles.small}>
                      De server leest de ondertitels uit het bestand…
                    </Text>
                  )}
                  {cues.status.kind === 'error' && (
                    <Text style={{ color: colors.danger }}>
                      Ondertitels lukken niet: {cues.status.message}
                    </Text>
                  )}
                </View>
                {cues.selected && (
                  <View style={styles.shift}>
                    <Text style={styles.choiceText}>
                      Verschuiving {cues.shiftMs > 0 ? '+' : ''}
                      {(cues.shiftMs / 1000).toLocaleString('nl-NL', {
                        minimumFractionDigits: 1,
                      })}{' '}
                      s
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <TvButton
                        label="−0,5 s"
                        onPress={() => cues.changeShift(cues.shiftMs - 500)}
                        style={{ flex: 1 }}
                      />
                      <TvButton
                        label="+0,5 s"
                        onPress={() => cues.changeShift(cues.shiftMs + 500)}
                        style={{ flex: 1 }}
                      />
                    </View>
                  </View>
                )}
                <SubtitleSearch fileId={fileId} onAdded={cues.added} />
              </>
            ) : (
              <>
                <View style={{ gap: 4 }}>
                  <Text style={styles.legend}>Kwaliteit</Text>
                  {QUALITIES.map((q) => (
                    <Choice
                      key={q.id}
                      label={QUALITY_LABEL[q.id]}
                      on={quality === q.id}
                      onPress={() => onQuality(q.id)}
                    />
                  ))}
                </View>
                <View style={{ gap: 4 }}>
                  <Text style={styles.legend}>Beeldformaat</Text>
                  {FIT_MODES.map((mode) => (
                    <Choice
                      key={mode}
                      label={FIT_LABEL[mode]}
                      on={fitMode === mode}
                      onPress={() => onFitMode(mode)}
                    />
                  ))}
                  <Text style={styles.hint}>
                    Automatisch vult het scherm als er alleen zwarte balken wegvallen.
                  </Text>
                </View>
                {skipSettings && onSkipSettings && (
                  <View style={{ gap: 4 }}>
                    <Text style={styles.legend}>Automatisch overslaan</Text>
                    {SKIP_OPTIONS.map(({ kind, label }) => (
                      <Choice
                        key={kind}
                        label={label}
                        on={skipSettings[kind]}
                        onPress={() => onSkipSettings({ [kind]: !skipSettings[kind] })}
                      />
                    ))}
                    <Text style={styles.hint}>Voor dit profiel, op elk apparaat.</Text>
                  </View>
                )}
                <View style={{ gap: 4 }}>
                  <Text style={styles.legend}>Afspelen</Text>
                  <Text style={styles.choiceText}>{summary}</Text>
                  {tracks.length > 0 && (
                    <Text style={styles.hint}>
                      {tracks.length} audiosporen,{' '}
                      {channelsLabel(Math.max(0, ...tracks.map((t) => t.channels ?? 0)))}
                    </Text>
                  )}
                </View>
              </>
            )}
          </ScrollView>
          <Text style={styles.hint}>Terug om te sluiten</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  skip: {
    position: 'absolute',
    right: TV_GUTTER,
    bottom: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingLeft: 22,
    paddingRight: 10,
    minHeight: 56,
    borderRadius: radius.s,
    borderWidth: 2,
    borderColor: colors.brass,
    backgroundColor: 'rgba(10,18,48,0.88)',
  },
  skipText: { color: colors.text, fontSize: 20, fontWeight: '800' },
  okKey: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.brass,
  },
  okText: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  spinner: { position: 'absolute', alignSelf: 'center', top: '45%' },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: TV_GUTTER,
    paddingTop: 28,
    paddingBottom: 40,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  title: { color: colors.text, fontSize: 26, fontWeight: '800' },
  subtitle: { color: colors.text2, fontSize: 17, marginTop: 2 },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: TV_GUTTER,
    paddingTop: 36,
    paddingBottom: 28,
    gap: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  seekOnly: { paddingTop: 20, backgroundColor: 'rgba(0,0,0,0.45)' },
  timeline: {
    borderRadius: radius.m,
    borderWidth: 2,
    borderColor: 'transparent',
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  timelineFocused: { borderColor: colors.brass, backgroundColor: 'rgba(224,176,79,0.08)' },
  timelineRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  track: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(242,244,250,0.3)',
    justifyContent: 'center',
  },
  trackFocused: { height: 10, borderRadius: 5 },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 5,
    backgroundColor: colors.brass,
  },
  knob: {
    position: 'absolute',
    width: 22,
    height: 22,
    marginLeft: -11,
    borderRadius: 11,
    backgroundColor: colors.text,
    borderWidth: 3,
    borderColor: colors.brass,
  },
  time: {
    color: colors.text,
    fontSize: 17,
    fontVariant: ['tabular-nums'],
    minWidth: 74,
    textAlign: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  round: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  roundFocused: {
    backgroundColor: colors.brass,
    borderColor: colors.brass,
    transform: [{ scale: 1.1 }],
  },
  overlay: {
    position: 'absolute',
    alignSelf: 'center',
    top: '22%',
    maxWidth: 620,
    padding: 28,
    gap: 14,
    alignItems: 'center',
    borderRadius: radius.l,
    backgroundColor: 'rgba(10,18,48,0.94)',
  },
  overlayText: { color: colors.text, fontSize: 19, textAlign: 'center' },
  next: {
    position: 'absolute',
    right: TV_GUTTER,
    bottom: 48,
    width: 460,
    padding: 24,
    gap: 12,
    borderRadius: radius.l,
    backgroundColor: 'rgba(10,18,48,0.95)',
  },
  eyebrow: {
    color: colors.brass,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  nextTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 460,
    paddingHorizontal: 28,
    paddingTop: 28,
    paddingBottom: 18,
    gap: 12,
    backgroundColor: 'rgba(10,18,48,0.97)',
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
  },
  panelTitle: { color: colors.text, fontSize: 24, fontWeight: '800' },
  legend: {
    color: colors.text3,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 50,
    paddingHorizontal: 12,
    borderRadius: radius.s,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  choiceFocused: { borderColor: colors.brass, backgroundColor: 'rgba(224,176,79,0.22)' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.text3 },
  radioOn: { borderColor: colors.brass, backgroundColor: colors.brass },
  choiceText: { color: colors.text, fontSize: 17, flexShrink: 1 },
  shift: {
    gap: 10,
    padding: 14,
    borderRadius: radius.s,
    backgroundColor: 'rgba(242,244,250,0.05)',
  },
  result: {
    gap: 2,
    padding: 12,
    borderRadius: radius.s,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: 'rgba(242,244,250,0.05)',
  },
  muted: { color: colors.text2, fontSize: 16 },
  small: { color: colors.text3, fontSize: 14, textAlign: 'center' },
  hint: { color: colors.text3, fontSize: 14, lineHeight: 20, marginTop: 4 },
});
