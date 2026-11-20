// "Wordt gedownload": how far Radarr or Sonarr is with a title, as a bar with
// the percentage and the time left.

import { downloadEpisodesLabel, type DownloadProgress, downloadLabel } from '@cinevault/shared';
import { Icon } from './Icon.js';

/** The age shown with a title's facts: "AL", "12+". */
export function ageFact(age: number | undefined): string {
  if (age === undefined) return '';
  return age === 0 ? 'AL' : `${age}+`;
}

export function DownloadLine({
  download,
  large,
}: {
  download: DownloadProgress;
  /** On a title's page: a panel with a heading. */
  large?: boolean;
}) {
  const trouble = download.state === 'failed' || download.state === 'warning';
  const episodes = downloadEpisodesLabel(download.episodes);
  const percent = Math.round(Math.max(0, Math.min(1, download.progress)) * 100);
  return (
    <div
      className={`download${large ? ' large' : ''}${trouble ? ' trouble' : ''}${download.state === 'queued' ? ' queued' : ''}`}
    >
      {large && (
        <p className="download-head">
          <Icon name="chevronDown" /> <strong>Wordt gedownload</strong>
          {episodes && <span className="muted">{episodes}</span>}
        </p>
      )}
      <div
        className="download-track"
        role="progressbar"
        aria-label="Download"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="download-fill" style={{ width: `${Math.max(2, percent)}%` }} />
      </div>
      <p className="download-label">
        {downloadLabel(download)}
        {!large && episodes ? ` · ${episodes}` : ''}
      </p>
    </div>
  );
}
