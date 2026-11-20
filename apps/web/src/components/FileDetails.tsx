import type { MediaFileDto } from '@cinevault/shared';
import {
  bitrateLabel,
  channelsLabel,
  codecLabel,
  durationLabel,
  languageLabel,
  resolutionLabel,
  sizeLabel,
} from '../format.js';
import { describeProblems, directPlay, plan, planSummary, savedQuality } from '../playback.js';

/** Short line like "4K · HEVC · HDR10 · 2 u 12 min". */
export function fileSummary(file: MediaFileDto): string {
  return [
    resolutionLabel(file.width, file.height),
    codecLabel(file.videoCodec),
    file.hdrFormat,
    durationLabel(file.durationMs),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function FileDetails({ file }: { file: MediaFileDto }) {
  const result = directPlay(file);
  return (
    <details className="file-details">
      <summary>Technische details</summary>
      <dl>
        <dt>Bestand</dt>
        <dd className="path">{file.path}</dd>
        <dt>Grootte</dt>
        <dd>
          {sizeLabel(file.size)}
          {file.bitrate ? ` · ${bitrateLabel(file.bitrate)}` : ''}
        </dd>
        <dt>Video</dt>
        <dd>
          {[
            codecLabel(file.videoCodec),
            file.width && file.height ? `${file.width}×${file.height}` : '',
            file.bitDepth ? `${file.bitDepth}-bit` : '',
            file.hdrFormat ?? 'SDR',
          ]
            .filter(Boolean)
            .join(' · ')}
        </dd>
        <dt>Audio</dt>
        <dd>
          {file.audioTracks.length === 0 ? (
            'geen'
          ) : (
            <ul>
              {file.audioTracks.map((track) => (
                <li key={track.index}>
                  {[
                    languageLabel(track.language),
                    codecLabel(track.codec),
                    channelsLabel(track.channels),
                    track.title,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {track.default && <span className="tag">standaard</span>}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Ondertitels</dt>
        <dd>
          {file.subtitleTracks.length === 0 ? (
            'geen'
          ) : (
            <ul>
              {file.subtitleTracks.map((track) => (
                <li key={track.index}>
                  {[languageLabel(track.language), codecLabel(track.codec), track.title]
                    .filter(Boolean)
                    .join(' · ')}
                  {track.forced && <span className="tag">geforceerd</span>}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>In deze browser</dt>
        <dd>
          {result.verdict === 'yes'
            ? 'Speelt direct af.'
            : result.verdict === 'maybe'
              ? 'Speelt waarschijnlijk direct af.'
              : `Niet direct afspeelbaar: ${describeProblems(result.problems)}.`}
          {result.verdict === 'no' && ` ${planSummary(plan(file, { quality: savedQuality() }))}.`}
        </dd>
        {file.probeError && (
          <>
            <dt>ffprobe</dt>
            <dd className="warning">{file.probeError}</dd>
          </>
        )}
      </dl>
    </details>
  );
}
