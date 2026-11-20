import type { MediaFileDto } from '@cinevault/shared';
import { useEffect, useRef, useState } from 'react';
import { bitrateLabel, codecLabel } from '../format.js';
import { playQuietly } from '../playback.js';
import { Icon } from './Icon.js';
import {
  bufferedAhead,
  diagnose,
  measureThroughput,
  type Diagnosis,
  type PlaybackSample,
  type Throughput,
} from '../playbackStats.js';

const TEST_BYTES = 64 * 1024 * 1024;

const number = (value: number, digits = 0) =>
  value.toLocaleString('nl-NL', { maximumFractionDigits: digits });

function percent(share: number): string {
  return `${number(share * 100, 1)}%`;
}

function advice(diagnosis: Diagnosis, file: MediaFileDto, throughput?: Throughput): string {
  const needed = bitrateLabel(file.bitrate);
  switch (diagnosis.kind) {
    case 'decoder':
      return `Dit apparaat laat ${percent(diagnosis.droppedShare)} van de beelden vallen: het kan deze video niet snel genoeg decoderen. Kies een lagere kwaliteit (1080p of 720p), of een browser of apparaat met hardware-decoding voor ${codecLabel(file.videoCodec)}.`;
    case 'network':
      return `De verbinding haalt ${bitrateLabel(throughput?.bps)}, maar dit bestand vraagt gemiddeld ${needed}. Dat is te weinig voor de originele kwaliteit; kies 1080p of 720p.`;
    case 'tight':
      return `De verbinding haalt ${bitrateLabel(throughput?.bps)} bij gemiddeld ${needed} voor dit bestand. Drukke stukken gaan daar overheen, dus haperen kan; 1080p of 720p is veiliger.`;
    case 'unknown':
      return throughput
        ? 'Het afspelen wachtte op data, terwijl de verbinding snel genoeg lijkt. Doe de test nog eens als het hapert.'
        : 'Het afspelen wachtte op data. Doe de snelheidstest om te zien of de verbinding snel genoeg is.';
    case 'ok':
      return throughput ? 'Verbinding en decoder houden dit bestand bij.' : '';
  }
}

/** Player statistics: buffer, dropped frames, stalls and a speed test. */
export function PlaybackStats({
  video,
  file,
  streamUrl,
  mode,
  onClose,
}: {
  video: HTMLVideoElement | null;
  file: MediaFileDto;
  streamUrl: string;
  /** How the file is played (direct, remux, transcode), see planSummary. */
  mode?: string;
  onClose?: () => void;
}) {
  const [sample, setSample] = useState<PlaybackSample>({
    droppedFrames: 0,
    totalFrames: 0,
    stalls: 0,
  });
  const [ahead, setAhead] = useState(0);
  const [size, setSize] = useState<[number, number]>();
  const [throughput, setThroughput] = useState<Throughput>();
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string>();
  const stalls = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (!video) return;
    let started = false;
    // Waiting before the first frame is the normal start-up, not a stall.
    const onPlaying = () => (started = true);
    const onWaiting = () => {
      if (started) stalls.current++;
    };
    const update = () => {
      const quality = video.getVideoPlaybackQuality?.();
      setSample({
        droppedFrames: quality?.droppedVideoFrames ?? 0,
        totalFrames: quality?.totalVideoFrames ?? 0,
        stalls: stalls.current,
      });
      setAhead(bufferedAhead(video));
      if (video.videoWidth) setSize([video.videoWidth, video.videoHeight]);
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    update();
    const timer = setInterval(update, 1_000);
    return () => {
      clearInterval(timer);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
    };
  }, [video]);

  useEffect(() => () => abort.current?.abort(), []);

  async function runTest() {
    setTesting(true);
    setTestError(undefined);
    // Paused, the player doesn't compete with the test for the connection.
    const wasPlaying = video ? !video.paused : false;
    video?.pause();
    abort.current = new AbortController();
    try {
      const offset = file.size > 2 * TEST_BYTES ? Math.floor(file.size / 2) : 0;
      setThroughput(
        await measureThroughput(streamUrl, {
          offset,
          maxBytes: TEST_BYTES,
          signal: abort.current.signal,
        }),
      );
    } catch {
      if (!abort.current.signal.aborted) setTestError('De snelheidstest is mislukt.');
    } finally {
      setTesting(false);
      if (wasPlaying && video) playQuietly(video);
    }
  }

  const diagnosis = diagnose(sample, file.bitrate, throughput);
  const message = advice(diagnosis, file, throughput);
  const droppedShare = sample.totalFrames ? sample.droppedFrames / sample.totalFrames : 0;
  const depth = file.bitDepth && file.bitDepth > 8 ? ` ${file.bitDepth}-bit` : '';

  return (
    <aside className="playback-stats" aria-label="Statistieken">
      <header className="sheet-head">
        <h2>Statistieken</h2>
        {onClose && (
          <button
            type="button"
            className="icon-button"
            aria-label="Statistieken sluiten"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        )}
      </header>
      <dl>
        {mode && (
          <>
            <dt>Afspelen</dt>
            <dd>{mode}</dd>
          </>
        )}
        <dt>Beeld</dt>
        <dd>
          {size ? `${size[0]}×${size[1]}` : `${file.width ?? '?'}×${file.height ?? '?'}`}{' '}
          {codecLabel(file.videoCodec)}
          {depth}
          {file.hdrFormat ? ` ${file.hdrFormat}` : ''}
        </dd>
        <dt>Bitrate bestand</dt>
        <dd>{file.bitrate ? `gemiddeld ${bitrateLabel(file.bitrate)}` : 'onbekend'}</dd>
        <dt>Gebufferd</dt>
        <dd>{number(ahead)} s vooruit</dd>
        <dt>Weggevallen beelden</dt>
        <dd>
          {number(sample.droppedFrames)} van {number(sample.totalFrames)}
          {sample.totalFrames ? ` (${percent(droppedShare)})` : ''}
        </dd>
        <dt>Haperingen</dt>
        <dd>{number(sample.stalls)}</dd>
        <dt>Snelheid</dt>
        <dd>
          {throughput
            ? `${bitrateLabel(throughput.bps)}${file.bitrate ? ` (${number(throughput.bps / file.bitrate, 1)}× de bitrate)` : ''}`
            : '–'}
        </dd>
      </dl>
      <button type="button" className="button secondary" onClick={runTest} disabled={testing}>
        {testing ? 'Bezig met testen…' : 'Snelheidstest'}
      </button>
      {testError && <p role="alert">{testError}</p>}
      {message && <p className="diagnosis">{message}</p>}
    </aside>
  );
}
