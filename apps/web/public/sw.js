// Web push for CineVault: shows the notification, and a tap opens the app at
// the title (or brings an open tab there). Nothing else: no offline cache.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = { title: 'CineVault', body: '', url: '/', tag: 'cinevault' };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    // Not JSON: show the defaults.
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: message.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
      if (tab) {
        await tab.focus();
        await tab.navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
