// The player's own controls over the video: tap to show or hide them, double
// tap left or right to seek 10 s, pinch to fill the screen or fit the
// picture, a timeline of the whole file, and sheets for audio, subtitles,
// quality and picture fit.

import {
  type AudioTrack,
  canReadAsText,
  type FileContext,
  pictureSubtitleNote,
  QUALITIES,
  type Quality,
  type SkipSettings,
  type SubtitleSearchResult,
} from '@cinevault/shared';
import Slider from '@react-native-community/slider';
import { LinearGradient } from 'expo-linear-gradient';
import type { VideoPlayer } from 'expo-video';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { px } from '../car';
import { CastIcon } from '../components/CastIcon';
import { Icon, type IconName } from '../components/Icon';
import { Button, IconButton } from '../components/ui';
import { channelsLabel, clockLabel, codecLabel, languageLabel } from '../format';
import { useSession } from '../session';
import { colors, radius } from '../theme';
import { SeekPreview, useThumbnails } from './SeekPreview';
import { FIT_LABEL, type FitMode } from './fit';
import type { useCues } from './useCues';

const HIDE_AFTER_MS = 3_500;
const SEEK_STEP = 10;
const DOUBLE_TAP_MS = 280;
/** Fingers this much further apart (or closer) switch between filling and fitting. */
const PINCH_RATIO = 1.2;
const FIT_MODES: FitMode[] = ['auto', 'fit', 'fill'];
/**
 * How long the player must stay stopped (or buffering) before the controls
 * react. Early in an HLS stream the player reports playing and not playing
 * many times a second, which made the controls flash.
 */
const STOPPED_MS = 800;
const WAITING_MS = 400;

export const QUALITY_LABEL: Record<Quality, string> = {
  original: 'Origineel',
  '1080p': '1080p',
  '720p': '720p',
};

export function trackLabel(track: AudioTrack): string {
  return [
    languageLabel(track.language),
    track.title,
    codecLabel(track.codec),
    channelsLabel(track.channels),
  ]
    .filter(Boolean)
    .join(' · ');
}

type Cues = ReturnType<typeof useCues>;
type Sheet = 'none' | 'audio' | 'settings';

/** "Automatisch overslaan" in the settings: per part, for this profile. */
export const SKIP_OPTIONS: { kind: keyof SkipSettings; label: string }[] = [
  { kind: 'intro', label: 'Intro' },
  { kind: 'recap', label: 'Recap' },
  { kind: 'credits', label: 'Aftiteling (de volgende aflevering meteen)' },
  { kind: 'preview', label: 'Preview van de volgende aflevering' },
];

function Choice({
  label,
  on,
  onPress,
  disabled,
  check,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** A checkbox (on or off) instead of one of several. */
  check?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={check ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: on, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.choice,
        on && { backgroundColor: colors.brassSoft },
        disabled && { opacity: 0.45 },
      ]}
    >
      <View style={[styles.radio, on && styles.radioOn]} />
      <Text style={styles.choiceText}>{label}</Text>
    </Pressable>
  );
}

function SubtitleSearch({ fileId, onAdded }: { fileId: string; onAdded: Cues['added'] }) {
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
    <View style={{ gap: 8 }}>
      {!results && (
        <Button
          label={busy === 'search' ? 'Zoeken…' : 'Zoeken op OpenSubtitles'}
          kind="secondary"
          icon="search"
          disabled={busy !== undefined}
          onPress={() => void search()}
        />
      )}
      {results?.length === 0 && <Text style={styles.muted}>Niets gevonden.</Text>}
      {results?.slice(0, 12).map((result) => (
        <Pressable
          key={result.id}
          accessibilityRole="button"
          disabled={busy !== undefined}
          onPress={() => void download(result)}
          style={styles.result}
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
        </Pressable>
      ))}
      {error && <Text style={{ color: colors.danger }}>{error}</Text>}
    </View>
  );
}

export type ControlsProps = {
  player: VideoPlayer;
  title: string;
  subtitle?: string;
  position: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  onSeek: (seconds: number) => void;
  onBack: () => void;
  fitMode: FitMode;
  onFitMode: (mode: FitMode) => void;
  /** Fingers apart (wider: fill the screen) or together (fit the picture). */
  onPinch: (wider: boolean) => void;
  quality: Quality;
  onQuality: (quality: Quality) => void;
  tracks: AudioTrack[];
  audioTrack: number | undefined;
  onAudioTrack: (index: number) => void;
  cues: Cues;
  fileId: string;
  summary: string;
  phase: { kind: string; position?: number; message?: string };
  resumedAt: number;
  onRestart: () => void;
  next: FileContext['next'];
  ended: boolean;
  countdown: number;
  onPlayNext: () => void;
  /** While the intro plays: "Intro overslaan"; also the recap, preview and credits (skipLabel). */
  onSkipIntro?: (() => void) | undefined;
  skipLabel?: string;
  /** The skip button's first 8 s: shown without the controls; after that only with them. */
  skipFresh?: boolean;
  /** The next-episode card shows at the end credits: "Aftiteling bekijken" instead of "Stoppen". */
  onWatchCredits?: (() => void) | undefined;
  /** What this profile skips by itself (on every device), and changing it. */
  skipSettings?: SkipSettings | undefined;
  onSkipSettings?: (change: Partial<SkipSettings>) => void;
  /** Admins: correcting the intro, recap and end credits (phone and tablet only). */
  introEditor?: ReactNode;
  /** The controls came into view or went away (the subtitles move up above them). */
  onShownChange?: (shown: boolean) => void;
};

export function Controls({
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
  onPinch,
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
  introEditor,
  onShownChange,
}: ControlsProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const portrait = height > width;
  // Narrow: the buttons in the bottom row lose their long labels.
  const narrow = width < px(560);
  // A tablet or a car: audio and subtitles side by side in a wider panel.
  const twoColumns = !portrait && width >= px(1000);
  const [locked, setLocked] = useState(false);
  const [unlockHint, setUnlockHint] = useState(false);
  const [bottomHeight, setBottomHeight] = useState(0);
  const [visible, setVisible] = useState(true);
  const [sheet, setSheet] = useState<Sheet>('none');
  const [scrub, setScrub] = useState<number>();
  // Where the slider is in the timeline row, for the picture above it.
  const [slider, setSlider] = useState({ x: 0, width: 0, row: 0 });
  const thumbnails = useThumbnails(fileId);
  const [ripple, setRipple] = useState<{ side: 'left' | 'right'; key: number }>();
  const [resumeNotice, setResumeNotice] = useState(resumedAt > 0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTap = useRef<{ time: number; side: 'left' | 'right' } | undefined>(undefined);
  const pinch = useRef<{ distance: number; done: boolean } | undefined>(undefined);
  const [fitNotice, setFitNotice] = useState<{ label: string; key: number }>();
  const [userPaused, setUserPaused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [waiting, setWaiting] = useState(false);

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

  // Paused by the viewer, or stopped from elsewhere (headset, call) for a while.
  const paused = userPaused || (stopped && !playing && !waiting);

  const wake = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    // Shown at the start, hidden once it plays a moment.
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    return () => {
      clearTimeout(hideTimer.current);
      clearTimeout(tapTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!fitNotice) return;
    const timer = setTimeout(() => setFitNotice(undefined), 1_500);
    return () => clearTimeout(timer);
  }, [fitNotice]);

  useEffect(() => {
    if (!resumeNotice) return;
    const timer = setTimeout(() => setResumeNotice(false), 8_000);
    return () => clearTimeout(timer);
  }, [resumeNotice]);

  // Paused, a sheet open or the end: the controls stay. Locked: never.
  const shown = !locked && (visible || paused || sheet !== 'none' || scrub !== undefined);

  useEffect(() => {
    onShownChange?.(shown);
  }, [shown, onShownChange]);

  useEffect(() => {
    if (!unlockHint) return;
    const timer = setTimeout(() => setUnlockHint(false), 3_000);
    return () => clearTimeout(timer);
  }, [unlockHint]);

  function togglePlay() {
    if (paused) {
      setUserPaused(false);
      setStopped(false);
      player.play();
    } else {
      setUserPaused(true);
      player.pause();
    }
    wake();
  }

  function seekBy(seconds: number) {
    onSeek(position + seconds);
    wake();
  }

  function onSurface(x: number) {
    // Locked (a child watching): a tap only shows the way to unlock.
    if (locked) {
      setUnlockHint(true);
      return;
    }
    const side = x < width / 2 ? 'left' : 'right';
    const now = Date.now();
    const previous = lastTap.current;
    if (previous && now - previous.time < DOUBLE_TAP_MS && previous.side === side) {
      clearTimeout(tapTimer.current);
      lastTap.current = undefined;
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

  function onTouchMove(touches: readonly { pageX: number; pageY: number }[]) {
    const [a, b] = touches;
    if (locked || touches.length !== 2 || !a || !b) return;
    const distance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
    const start = pinch.current;
    if (!start) {
      pinch.current = { distance, done: false };
      return;
    }
    if (start.done || start.distance <= 0) return;
    const ratio = distance / start.distance;
    if (ratio >= PINCH_RATIO || ratio <= 1 / PINCH_RATIO) {
      const wider = ratio > 1;
      start.done = true;
      onPinch(wider);
      setFitNotice({ label: FIT_LABEL[wider ? 'fill' : 'fit'], key: Date.now() });
    }
  }

  const time = scrub ?? position;
  const pad = {
    paddingLeft: Math.max(insets.left, px(20)),
    paddingRight: Math.max(insets.right, px(20)),
  };
  const lift = shown && bottomHeight > 0 ? bottomHeight + px(12) : Math.max(insets.bottom, px(24));

  return (
    <View
      style={StyleSheet.absoluteFill}
      onTouchMove={(event) => onTouchMove(event.nativeEvent.touches)}
      onTouchEnd={(event) => {
        if (event.nativeEvent.touches.length < 2) pinch.current = undefined;
      }}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={(event) => onSurface(event.nativeEvent.locationX)}
        accessibilityLabel={
          locked ? 'Scherm vergrendeld' : shown ? 'Bediening verbergen' : 'Bediening tonen'
        }
      />
      {ripple && (
        <View
          key={ripple.key}
          pointerEvents="none"
          style={[styles.ripple, ripple.side === 'left' ? styles.rippleLeft : styles.rippleRight]}
        >
          <Icon name={ripple.side === 'left' ? 'replay10' : 'forward10'} size={40} />
          <Text style={styles.rippleText}>{SEEK_STEP} seconden</Text>
        </View>
      )}

      {fitNotice && (
        <View key={fitNotice.key} pointerEvents="none" style={styles.fitNotice}>
          <Text style={styles.fitNoticeText}>{fitNotice.label}</Text>
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

      {shown && (
        <>
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(0,0,0,0.78)', 'rgba(0,0,0,0)']}
            style={styles.topShade}
          />
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.85)']}
            style={styles.bottomShade}
          />
          <View
            style={[styles.top, pad, { paddingTop: Math.max(insets.top, px(10)) }]}
            pointerEvents="box-none"
          >
            <IconButton icon="back" label="Terug" onPress={onBack} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <CastIcon />
            <IconButton
              icon="lock"
              label="Scherm vergrendelen"
              onPress={() => {
                setSheet('none');
                setLocked(true);
                setUnlockHint(true);
              }}
            />
          </View>

          {!waiting && (
            <View
              style={[styles.center, { gap: portrait ? px(40) : px(72) }]}
              pointerEvents="box-none"
            >
              <IconButton
                icon="replay10"
                label="10 seconden terug"
                size={58}
                onPress={() => seekBy(-SEEK_STEP)}
                style={styles.centerButton}
              />
              <IconButton
                icon={paused ? 'play' : 'pause'}
                label={paused ? 'Afspelen' : 'Pauze'}
                size={84}
                onPress={togglePlay}
                style={styles.playButton}
              />
              <IconButton
                icon="forward10"
                label="10 seconden vooruit"
                size={58}
                onPress={() => seekBy(SEEK_STEP)}
                style={styles.centerButton}
              />
            </View>
          )}

          <View
            style={[styles.bottom, pad, { paddingBottom: Math.max(insets.bottom, px(10)) }]}
            onLayout={(event) => setBottomHeight(event.nativeEvent.layout.height)}
          >
            <View
              style={styles.timeline}
              onLayout={(event) => {
                const row = event.nativeEvent.layout.width;
                setSlider((current) => ({ ...current, row }));
              }}
            >
              {thumbnails && scrub !== undefined && slider.width > 0 && (
                <SeekPreview
                  thumbnails={thumbnails}
                  time={scrub}
                  center={slider.x + (scrub / Math.max(1, duration)) * slider.width}
                  bounds={slider.row}
                  width={Math.min(px(200), Math.round(width * 0.3))}
                />
              )}
              <Text style={styles.time}>{clockLabel(time)}</Text>
              <Slider
                onLayout={(event) => {
                  const { x, width: sliderWidth } = event.nativeEvent.layout;
                  setSlider((current) => ({ ...current, x, width: sliderWidth }));
                }}
                style={{ flex: 1, height: px(40) }}
                minimumValue={0}
                maximumValue={Math.max(1, duration)}
                value={time}
                minimumTrackTintColor={colors.brass}
                maximumTrackTintColor="rgba(242,244,250,0.3)"
                thumbTintColor={colors.brass}
                accessibilityLabel="Positie"
                onSlidingStart={(value) => {
                  clearTimeout(hideTimer.current);
                  setScrub(value);
                }}
                onValueChange={(value) =>
                  setScrub((current) => (current === undefined ? current : value))
                }
                onSlidingComplete={(value) => {
                  setScrub(undefined);
                  onSeek(value);
                  wake();
                }}
              />
              <Text style={[styles.time, styles.timeLeft]}>
                -{clockLabel(Math.max(0, duration - time))}
              </Text>
            </View>
            <View style={styles.row}>
              <BarButton
                icon="subtitles"
                label={narrow ? 'Audio' : 'Audio en ondertitels'}
                active={Boolean(cues.selected)}
                onPress={() => setSheet('audio')}
              />
              <BarButton
                icon="settings"
                label={narrow ? QUALITY_LABEL[quality] : `Instellingen · ${QUALITY_LABEL[quality]}`}
                onPress={() => setSheet('settings')}
              />
              <View style={{ flex: 1 }} />
              {next && (
                <BarButton
                  icon="next"
                  label={narrow ? 'Volgende' : 'Volgende aflevering'}
                  onPress={onPlayNext}
                  strong
                />
              )}
            </View>
          </View>
        </>
      )}

      {locked && unlockHint && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scherm ontgrendelen"
          onPress={() => {
            setLocked(false);
            setUnlockHint(false);
            wake();
          }}
          style={({ pressed }) => [styles.unlock, pressed && { opacity: 0.8 }]}
        >
          <Icon name="unlock" size={22} color={colors.ink} />
          <Text style={styles.unlockText}>Tik om te ontgrendelen</Text>
        </Pressable>
      )}

      {onSkipIntro && sheet === 'none' && !locked && (skipFresh || shown) && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            onSkipIntro();
            wake();
          }}
          style={({ pressed }) => [
            styles.skip,
            { right: Math.max(insets.right, px(20)), bottom: lift },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.skipText}>{skipLabel}</Text>
          <Icon name="next" size={18} color={colors.ink} />
        </Pressable>
      )}

      {resumeNotice && phase.kind !== 'error' && !locked && (
        <View style={[styles.notice, { bottom: lift }]}>
          <Text style={styles.noticeText}>Verder vanaf {clockLabel(resumedAt)}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setResumeNotice(false);
              onSeek(0);
            }}
            style={styles.pill}
          >
            <Text style={styles.pillText}>Vanaf het begin</Text>
          </Pressable>
        </View>
      )}

      {phase.kind === 'queued' && (
        <View style={styles.overlay}>
          <ActivityIndicator color={colors.brass} />
          <Text style={styles.overlayText}>
            In de wachtrij{phase.position ? ` (plek ${phase.position})` : ''}: de server is al met
            andere video&apos;s bezig.
          </Text>
        </View>
      )}
      {phase.kind === 'error' && (
        <View style={styles.overlay}>
          <Icon name="alert" size={32} color={colors.danger} />
          <Text style={styles.overlayText}>Afspelen lukt niet: {phase.message}.</Text>
          <Text style={styles.small}>{summary}</Text>
          <Button label="Opnieuw proberen" onPress={onRestart} />
        </View>
      )}

      {ended && next && !locked && (
        <View
          style={[
            styles.next,
            portrait
              ? { left: px(16), right: px(16), bottom: lift }
              : { right: Math.max(insets.right, px(20)), bottom: lift },
          ]}
        >
          <Text style={styles.eyebrow}>Volgende aflevering over {countdown} s</Text>
          <View style={styles.countdownTrack}>
            <View
              style={[
                styles.countdownFill,
                { width: `${Math.max(0, Math.min(1, countdown / 10)) * 100}%` },
              ]}
            />
          </View>
          <Text style={styles.nextTitle} numberOfLines={2}>
            S{next.seasonNumber}:A{next.episodeNumber}
            {next.title ? ` · ${next.title}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button label="Nu afspelen" icon="play" onPress={onPlayNext} style={{ flex: 1 }} />
            {onWatchCredits ? (
              <Button label="Aftiteling bekijken" kind="secondary" onPress={onWatchCredits} />
            ) : (
              <Button label="Stoppen" kind="secondary" onPress={onBack} />
            )}
          </View>
        </View>
      )}

      {sheet !== 'none' && (
        <View
          style={
            portrait
              ? [
                  styles.sheet,
                  styles.sheetBottom,
                  { paddingBottom: Math.max(insets.bottom, px(12)) },
                ]
              : [
                  styles.sheet,
                  styles.sheetSide,
                  sheet === 'audio' && twoColumns && styles.sheetWide,
                  { paddingRight: Math.max(insets.right, px(20)) },
                ]
          }
        >
          {portrait && <View style={styles.grabber} />}
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>
              {sheet === 'audio' ? 'Audio en ondertitels' : 'Instellingen'}
            </Text>
            <IconButton icon="close" label="Sluiten" onPress={() => setSheet('none')} />
          </View>
          <ScrollView contentContainerStyle={{ gap: 18, paddingBottom: 24 }}>
            {sheet === 'audio' ? (
              <View style={twoColumns ? styles.columns : { gap: 18 }}>
                <View style={styles.column}>
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
                <View style={styles.column}>
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
                    <Text style={styles.error}>Omzetten lukt niet: {cues.readError}</Text>
                  )}
                  {cues.status.kind === 'reading' && (
                    <Text style={styles.small}>
                      De server leest de ondertitels uit het bestand…
                    </Text>
                  )}
                  {cues.status.kind === 'error' && (
                    <Text style={styles.error}>Ondertitels lukken niet: {cues.status.message}</Text>
                  )}
                  {cues.selected && (
                    <View style={styles.shift}>
                      <Text style={styles.choiceText}>
                        Verschuiving {cues.shiftMs > 0 ? '+' : ''}
                        {(cues.shiftMs / 1000).toLocaleString('nl-NL', {
                          minimumFractionDigits: 1,
                        })}{' '}
                        s
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Button
                          label="−0,5 s"
                          kind="secondary"
                          onPress={() => cues.changeShift(cues.shiftMs - 500)}
                          style={{ flex: 1 }}
                        />
                        <Button
                          label="+0,5 s"
                          kind="secondary"
                          onPress={() => cues.changeShift(cues.shiftMs + 500)}
                          style={{ flex: 1 }}
                        />
                      </View>
                    </View>
                  )}
                  <SubtitleSearch fileId={fileId} onAdded={cues.added} />
                </View>
              </View>
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
                    Automatisch vult het scherm als er alleen zwarte balken wegvallen. Knijp met
                    twee vingers om te wisselen.
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
                        check
                        onPress={() => onSkipSettings({ [kind]: !skipSettings[kind] })}
                      />
                    ))}
                    <Text style={styles.hint}>Voor dit profiel, op elk apparaat.</Text>
                  </View>
                )}
                {introEditor}
                <View style={{ gap: 4 }}>
                  <Text style={styles.legend}>Afspelen</Text>
                  <Text style={styles.muted}>{summary}</Text>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

/** A button in the bottom row: an icon with a label, brass when it is on. */
function BarButton({
  icon,
  label,
  onPress,
  active,
  strong,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
  strong?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.barButton,
        strong && styles.barButtonStrong,
        pressed && { backgroundColor: colors.glass },
      ]}
    >
      <Icon name={icon} size={22} color={active ? colors.brass : colors.text} />
      <Text style={[styles.barText, active && { color: colors.brass }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  topShade: { position: 'absolute', top: 0, left: 0, right: 0, height: 150 },
  bottomShade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 210 },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 8,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  subtitle: { color: colors.text2, fontSize: 14, marginTop: 1 },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerButton: {
    backgroundColor: 'rgba(10,18,48,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(242,244,250,0.22)',
  },
  playButton: {
    backgroundColor: 'rgba(10,18,48,0.55)',
    borderWidth: 2,
    borderColor: 'rgba(242,244,250,0.85)',
  },
  spinner: { position: 'absolute', alignSelf: 'center', top: '45%' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, gap: 2 },
  timeline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  time: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 58,
    textAlign: 'center',
  },
  timeLeft: { color: colors.text2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  barButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    borderRadius: 999,
  },
  barButtonStrong: { borderWidth: 1, borderColor: 'rgba(242,244,250,0.35)' },
  barText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  ripple: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '36%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(242,244,250,0.08)',
  },
  rippleLeft: { left: 0, borderTopRightRadius: 400, borderBottomRightRadius: 400 },
  rippleRight: { right: 0, borderTopLeftRadius: 400, borderBottomLeftRadius: 400 },
  rippleText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  fitNotice: {
    position: 'absolute',
    alignSelf: 'center',
    top: '42%',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radius.m,
    backgroundColor: 'rgba(10,18,48,0.85)',
  },
  fitNoticeText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  unlock: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: '12%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 22,
    borderRadius: 999,
    backgroundColor: colors.brass,
  },
  unlockText: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  skip: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: colors.text,
  },
  skipText: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  hint: { color: colors.text3, fontSize: 13, lineHeight: 18, marginTop: 4 },
  notice: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(10,18,48,0.9)',
  },
  noticeText: { color: colors.text, fontSize: 14 },
  pill: {
    backgroundColor: colors.glass,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pillText: { fontSize: 14, color: colors.text, fontWeight: '700' },
  overlay: {
    position: 'absolute',
    alignSelf: 'center',
    top: '25%',
    maxWidth: 460,
    marginHorizontal: 16,
    padding: 22,
    gap: 12,
    alignItems: 'center',
    borderRadius: radius.l,
    backgroundColor: 'rgba(10,18,48,0.92)',
  },
  overlayText: { color: colors.text, fontSize: 15, textAlign: 'center' },
  next: {
    position: 'absolute',
    width: 360,
    maxWidth: '92%',
    padding: 18,
    gap: 10,
    borderRadius: radius.l,
    backgroundColor: 'rgba(10,18,48,0.95)',
    borderWidth: 1,
    borderColor: colors.line,
  },
  eyebrow: {
    color: colors.brass,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  countdownTrack: {
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(242,244,250,0.15)',
  },
  countdownFill: { height: 3, backgroundColor: colors.brass },
  nextTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  sheet: { position: 'absolute', backgroundColor: colors.bg },
  sheetSide: {
    top: 0,
    right: 0,
    bottom: 0,
    width: 420,
    maxWidth: '75%',
    paddingLeft: 20,
    paddingTop: 12,
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
  },
  sheetWide: { width: 720, maxWidth: '62%' },
  sheetBottom: {
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '72%',
    paddingHorizontal: 20,
    paddingTop: 8,
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    marginBottom: 4,
    backgroundColor: colors.lineStrong,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  columns: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  column: { flex: 1, gap: 4 },
  legend: {
    color: colors.text3,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 10,
    borderRadius: radius.s,
  },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.text3 },
  radioOn: { borderColor: colors.brass, backgroundColor: colors.brass },
  choiceText: { color: colors.text, fontSize: 15, flexShrink: 1 },
  shift: {
    gap: 8,
    padding: 12,
    marginTop: 8,
    borderRadius: radius.s,
    backgroundColor: 'rgba(242,244,250,0.05)',
  },
  result: {
    gap: 2,
    padding: 10,
    borderRadius: radius.s,
    backgroundColor: 'rgba(242,244,250,0.05)',
  },
  error: { color: colors.danger, fontSize: 14 },
  muted: { fontSize: 14, color: colors.text2 },
  small: { color: colors.text3, fontSize: 12, textAlign: 'center' },
});
