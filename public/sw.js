// Ghostrun service worker: only shows game alerts and opens the game when one is tapped.
// It does not cache pages or work offline, so it can never serve an old version of the game.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Ghostrun';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'ghostrun',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-48.png',
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus();
    return self.clients.openWindow('/');
  })());
});
