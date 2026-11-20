import { ApiError } from '@cinevault/shared';
import { useState } from 'react';

export function Loading({ label = 'Laden…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}

export function ErrorBox({
  error,
  title = 'Er ging iets mis',
}: {
  error: unknown;
  title?: string;
}) {
  const message =
    error instanceof ApiError
      ? error.status === 404
        ? 'Niet gevonden.'
        : error.message
      : error instanceof Error
        ? error.message.includes('fetch')
          ? 'De CineVault-server is niet bereikbaar.'
          : error.message
        : String(error);
  return (
    <div className="error-box" role="alert">
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');
}

/**
 * Image with a placeholder when there is none or it fails to load. The
 * placeholder shows the title, or only initials where the name is printed
 * next to it anyway (cast, search results).
 */
export function Poster({
  url,
  title,
  className = 'poster',
  compact = false,
}: {
  url?: string;
  title: string;
  className?: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className={`${className} poster-placeholder`} aria-hidden="true">
        <span>{compact ? initials(title) : title}</span>
      </div>
    );
  }
  return (
    <img className={className} src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}

/**
 * The title as a picture (a TMDB logo), else as text. The text stays for screen
 * readers, and comes back when the picture can't load.
 */
export function TitleLogo({ url, title }: { url?: string | undefined; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <>{title}</>;
  return (
    <img
      className="title-logo"
      src={url}
      alt={title}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
