/* LOOP-KICK web-push service worker. Payloads are JSON {title, body, url, tag};
   a constant tag means the newest alert replaces the previous one on-device. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = String(data.title || 'LOOP-KICK');
  event.waitUntil(self.registration.showNotification(title, {
    body: String(data.body || ''),
    tag: String(data.tag || 'loop-kick'),
    icon: '/loop-mark.png',
    badge: '/loop-mark.png',
    data: { url: String(data.url || 'https://stockmarketloop.com/#loop-kick') },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  if (!url) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.url === url && 'focus' in tab) return tab.focus();
    }
    return self.clients.openWindow(url);
  }));
});
