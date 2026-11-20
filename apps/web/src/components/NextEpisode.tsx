import type { FileContext } from '@cinevault/shared';
import { type CSSProperties, useEffect, useState } from 'react';
import { Icon } from './Icon.js';

const NEXT_COUNTDOWN = 10;

/**
 * At the end credits, or after an episode: the next one starts by itself
 * after a short countdown (which waits while the video is paused).
 */
export function NextEpisode({
  next,
  onPlay,
  cancelLabel,
  onCancel,
  isPaused,
}: {
  next: NonNullable<FileContext['next']>;
  onPlay: () => void;
  cancelLabel: string;
  onCancel: () => void;
  isPaused?: () => boolean;
}) {
  const [left, setLeft] = useState(NEXT_COUNTDOWN);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isPaused?.()) setLeft((l) => l - 1);
    }, 1_000);
    return () => clearInterval(timer);
  }, [isPaused]);
  useEffect(() => {
    if (left <= 0) onPlay();
  }, [left, onPlay]);
  return (
    <div className="next-episode" role="status" data-focus-scope="modal">
      <p className="eyebrow">Volgende aflevering over {left} s</p>
      <h2>
        S{next.seasonNumber}:A{next.episodeNumber}
        {next.title ? ` · ${next.title}` : ''}
      </h2>
      <span
        className="countdown"
        style={{ '--left': `${(left / NEXT_COUNTDOWN) * 100}%` } as CSSProperties}
        aria-hidden="true"
      />
      <div className="actions">
        <button type="button" className="button primary" onClick={onPlay} data-autofocus>
          <Icon name="play" /> Nu afspelen
        </button>
        <button type="button" className="button secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
