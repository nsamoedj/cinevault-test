import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from './Icon.js';

/**
 * A row of cards that scrolls sideways: swipe on touch screens, arrows on
 * hover with a mouse, and the arrow keys (TV remotes) move card by card.
 */
export function Rail({
  title,
  more,
  shape = 'poster',
  children,
}: {
  title: string;
  /** "Alles bekijken" link. */
  more?: string;
  shape?: 'poster' | 'landscape';
  children: ReactNode;
}) {
  const id = useId();
  const track = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const update = useCallback(() => {
    const element = track.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    setEdges({ start: element.scrollLeft <= 4, end: element.scrollLeft >= max - 4 });
  }, []);

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [update, children]);

  function page(direction: 1 | -1) {
    const element = track.current;
    if (!element) return;
    element.scrollBy({ left: direction * element.clientWidth * 0.85, behavior: 'smooth' });
  }

  return (
    <section className={`rail ${shape}`} aria-labelledby={id}>
      <header className="rail-header">
        <h2 id={id}>{title}</h2>
        {more && (
          <Link to={more} className="rail-more">
            Alles bekijken <Icon name="chevronRight" />
          </Link>
        )}
      </header>
      <div className="rail-viewport">
        <button
          type="button"
          className="rail-arrow prev"
          aria-label={`Terug in ${title}`}
          tabIndex={-1}
          hidden={edges.start}
          onClick={() => page(-1)}
        >
          <Icon name="chevronLeft" />
        </button>
        <ul className="rail-track" ref={track} onScroll={update}>
          {children}
        </ul>
        <button
          type="button"
          className="rail-arrow next"
          aria-label={`Verder in ${title}`}
          tabIndex={-1}
          hidden={edges.end}
          onClick={() => page(1)}
        >
          <Icon name="chevronRight" />
        </button>
      </div>
    </section>
  );
}
