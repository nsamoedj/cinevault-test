import type { FeaturedItem } from '@cinevault/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { clockLabel, runtimeLabel } from '../format.js';
import { backdropSrc } from './backdrop.js';
import { ProgressBar } from './cards.js';
import { TitleLogo } from './common.js';
import { Icon } from './Icon.js';
import { MyListButton } from './MyListButton.js';

const ROTATE_MS = 9_000;

/** "4K", "HDR10", "Dolby Vision": what the file offers. */
export function qualityBadges(height?: number, hdrFormat?: string): string[] {
  const badges: string[] = [];
  if (height && height > 1600) badges.push('4K');
  else if (height && height > 900) badges.push('HD');
  if (hdrFormat) badges.push(hdrFormat === 'DV' ? 'Dolby Vision' : hdrFormat);
  return badges;
}

function playLabel(item: FeaturedItem): string {
  const play = item.play;
  if (play?.positionMs && play.positionMs >= 60_000) {
    return `Verder kijken${play.seasonNumber ? ` S${play.seasonNumber}:A${play.episodeNumber}` : ''}`;
  }
  if (play?.seasonNumber && !(play.seasonNumber === 1 && play.episodeNumber === 1)) {
    return `Afspelen S${play.seasonNumber}:A${play.episodeNumber}`;
  }
  return 'Afspelen';
}

/** The billboard at the top of the start page: a few titles that take turns. */
export function Hero({ items }: { items: FeaturedItem[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // Backdrops load when they are (about to be) shown, not all at once: at full
  // size on a 4K TV they are a few MB each.
  const [seen, setSeen] = useState(() => new Set([0, 1]));
  const item = items[index % Math.max(1, items.length)];

  const show = useCallback(
    (i: number) => {
      setIndex(i);
      setSeen((prev) => new Set([...prev, i, (i + 1) % Math.max(1, items.length)]));
    },
    [items.length],
  );

  useEffect(() => {
    if (items.length < 2 || paused) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setTimeout(() => show((index + 1) % items.length), ROTATE_MS);
    return () => clearTimeout(timer);
  }, [index, items.length, paused, show]);

  if (!item) return null;
  const play = item.play;
  const share =
    play?.positionMs && play.durationMs && play.positionMs >= 60_000
      ? play.positionMs / play.durationMs
      : 0;
  const facts = [
    item.year,
    item.type === 'SHOW' ? 'Serie' : runtimeLabel(item.runtimeMinutes),
  ].filter(Boolean);

  return (
    <section
      className="hero"
      aria-roledescription="carrousel"
      aria-label="Uitgelicht"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="hero-art" aria-hidden="true">
        {items.map((featured, i) =>
          seen.has(i) ? (
            <img
              key={featured.id}
              src={backdropSrc(featured.backdropUrl)}
              alt=""
              className={i === index ? 'shown' : undefined}
              {...(i === 0 && { fetchPriority: 'high' as const })}
            />
          ) : null,
        )}
      </div>
      <div className="hero-content" key={item.id}>
        <p className="hero-kind">{item.type === 'SHOW' ? 'Serie' : 'Film'}</p>
        <h1 className={`hero-title${item.logoUrl ? ' has-logo' : ''}`}>
          <TitleLogo url={item.logoUrl} title={item.title} />
        </h1>
        <p className="meta-line">
          {item.rating ? (
            <span className="rating">
              <Icon name="star" />{' '}
              {item.rating.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}
            </span>
          ) : null}
          {facts.map((fact) => (
            <span key={String(fact)}>{fact}</span>
          ))}
          {qualityBadges(item.height, item.hdrFormat).map((badge) => (
            <span key={badge} className="badge">
              {badge}
            </span>
          ))}
        </p>
        {item.overview && <p className="hero-overview">{item.overview}</p>}
        <div className="hero-actions">
          {play && (
            <Link to={`/play/${play.fileId}`} className="button primary large">
              <Icon name="play" /> {playLabel(item)}
            </Link>
          )}
          <Link to={`/items/${item.id}`} className="button glass large">
            <Icon name="info" /> Meer info
          </Link>
          <MyListButton itemId={item.id} inList={item.inMyList ?? false} compact />
        </div>
        {share > 0 && play?.durationMs && play.positionMs && (
          <div className="hero-progress">
            <ProgressBar share={share} />
            <span>nog {clockLabel((play.durationMs - play.positionMs) / 1000)}</span>
          </div>
        )}
      </div>
      {items.length > 1 && (
        <div className="hero-dots" role="group" aria-label="Kies een titel">
          {items.map((featured, i) => (
            <button
              key={featured.id}
              type="button"
              aria-label={featured.title}
              aria-current={i === index}
              onClick={() => show(i)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
