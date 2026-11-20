import { trailerEmbedUrl } from '@cinevault/shared';
import { useEffect, useRef } from 'react';
import { isBackKey } from '../spatialNav.js';
import { Icon } from './Icon.js';

/** The trailer from YouTube in a layer over the page. Escape, Back or ✕ closes it. */
export function TrailerDialog({
  videoKey,
  title,
  onClose,
}: {
  videoKey: string;
  title: string;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || isBackKey(event)) {
        // Before the app's own Back, which would leave the page.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="trailer-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`Trailer: ${title}`}
      data-focus-scope="modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="trailer-frame">
        <iframe
          src={trailerEmbedUrl(videoKey)}
          title={`Trailer: ${title}`}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      <button
        ref={close}
        type="button"
        className="icon-button round trailer-close"
        aria-label="Trailer sluiten"
        title="Sluiten"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
