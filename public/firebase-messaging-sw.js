importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

let messaging = null;
let firebaseInitPromise = null;
const recentNotifications = new Map();

function normalizePayloadValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {}
  }
  return value;
}

function normalizeObject(input) {
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, normalizePayloadValue(value)]));
}

async function ensureFirebaseMessaging() {
  if (messaging) return messaging;
  if (firebaseInitPromise) return firebaseInitPromise;

  firebaseInitPromise = (async () => {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) return null;
      const config = await response.json();
      if (!config || !config.firebase) return null;

      if (!firebase.apps.length) {
        firebase.initializeApp(config.firebase);
      }

      messaging = firebase.messaging();
      return messaging;
    } catch (_) {
      return null;
    }
  })();

  return firebaseInitPromise;
}

function shouldSuppressDuplicate(tag) {
  if (!tag) return false;
  const now = Date.now();
  const lastSeen = recentNotifications.get(tag) || 0;
  recentNotifications.set(tag, now);

  for (const [key, ts] of recentNotifications.entries()) {
    if (now - ts > 30000) recentNotifications.delete(key);
  }

  return now - lastSeen < 10000;
}

function parseIncomingPayload(rawPayload) {
  const root = normalizeObject(rawPayload || {});
  const data = normalizeObject(root.data);
  const notification = normalizeObject(root.notification);
  const merged = { ...root, ...data };
  const title = notification.title || merged.title || 'Fluent Feathers Academy';
  const body = notification.body || merged.body || '';
  const tag = merged.notificationTag || merged.type || [title, body].filter(Boolean).join('|').slice(0, 180);
  const clickAction = merged.click_action || merged.url || merged.link || '/';

  return {
    title,
    options: {
      body,
      icon: notification.icon || merged.icon || '/app-icon.png',
      badge: notification.badge || merged.badge || '/app-icon.png',
      tag,
      renotify: false,
      data: {
        ...merged,
        click_action: clickAction,
        url: clickAction,
        link: clickAction,
        notificationTag: tag
      }
    }
  };
}

function hasDisplayableNotification(rawPayload) {
  const root = normalizeObject(rawPayload || {});
  const notification = normalizeObject(root.notification);
  return !!(notification && (notification.title || notification.body));
}

function showNotificationFromPayload(rawPayload) {
  const { title, options } = parseIncomingPayload(rawPayload);
  if (!title || shouldSuppressDuplicate(options.tag)) {
    return Promise.resolve();
  }
  return self.registration.showNotification(title, options);
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    ensureFirebaseMessaging()
  ]));
});

ensureFirebaseMessaging().then((instance) => {
  if (!instance) return;
  instance.onBackgroundMessage((payload) => {
    if (hasDisplayableNotification(payload)) return;
    showNotificationFromPayload(payload);
  });
}).catch(() => {});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data.json();
    } catch (_) {
      payload = { body: event.data.text() };
    }
    if (hasDisplayableNotification(payload)) return;
    await showNotificationFromPayload(payload);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = normalizeObject(event.notification.data || {});
  const targetUrl = data.click_action || data.url || data.link || '/';

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if ('focus' in client) {
        const clientUrl = new URL(client.url);
        const desiredUrl = new URL(targetUrl, self.location.origin);
        if (clientUrl.pathname === desiredUrl.pathname) {
          client.postMessage({ type: 'ff-notification-click', targetUrl: desiredUrl.toString() });
          return client.focus();
        }
      }
    }
    return clients.openWindow(targetUrl);
  })());
});
