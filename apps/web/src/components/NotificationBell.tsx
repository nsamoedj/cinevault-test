import { type NotificationDto, type NotificationType, timeAgoLabel } from '@cinevault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, keys } from '../api.js';
import { claimPush } from '../push.js';
import { Icon, type IconName } from './Icon.js';

const ICON: Record<NotificationType, IconName> = {
  'new-episodes': 'tv',
  airing: 'calendar',
  recommended: 'sparkles',
  'new-login': 'user',
  'admin-unmatched': 'alert',
  'admin-transcoder': 'alert',
  'admin-health': 'alert',
  'request-new': 'plus',
  'request-update': 'sparkles',
  test: 'bell',
};

/** Where a notification leads in the web app. */
export function notificationPath(n: NotificationDto): string {
  if (n.path) return n.path;
  if (n.itemId) return `/items/${n.itemId}`;
  return '/';
}

/** The bell in the top bar: the inbox, with the number of unread ones. */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const inbox = useQuery({
    queryKey: keys.notifications,
    queryFn: () => api.notifications(),
    refetchInterval: 60_000,
  });
  const read = useMutation({
    mutationFn: (ids?: number[]) => api.readNotifications(ids),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });

  // This browser's push messages are for whoever is signed in now.
  useEffect(() => {
    void claimPush();
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', escape);
    box.current?.querySelector<HTMLElement>('.notification')?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const items = inbox.data?.items ?? [];
  const unread = inbox.data?.unread ?? 0;
  const go = (n: NotificationDto) => {
    setOpen(false);
    if (!n.read) read.mutate([n.id]);
    void navigate(notificationPath(n));
  };

  return (
    <div className="notification-menu" ref={box} data-focus-scope={open ? 'menu' : undefined}>
      <button
        ref={button}
        type="button"
        className="icon-button bell-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Meldingen, ${unread} nieuw` : 'Meldingen'}
        title="Meldingen"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className="bell-badge" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="menu notification-panel" role="dialog" aria-label="Meldingen">
          <header className="notification-head">
            <strong>Meldingen</strong>
            {unread > 0 && (
              <button type="button" className="link-button" onClick={() => read.mutate(undefined)}>
                Alles gelezen
              </button>
            )}
          </header>
          {items.length === 0 ? (
            <p className="muted notification-empty">
              Nog geen meldingen. Je hoort het hier als er een nieuwe aflevering is van een serie
              die je volgt.
            </p>
          ) : (
            <ul className="notification-list">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`notification${n.read ? '' : ' unread'}`}
                    onClick={() => go(n)}
                  >
                    <span className="notification-image" aria-hidden="true">
                      {n.imageUrl ? (
                        <img src={n.imageUrl} alt="" loading="lazy" />
                      ) : (
                        <Icon name={ICON[n.type] ?? 'bell'} />
                      )}
                    </span>
                    <span className="notification-text">
                      <strong>{n.title}</strong>
                      <span>{n.body}</span>
                      <time dateTime={n.createdAt}>{timeAgoLabel(n.createdAt)}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
