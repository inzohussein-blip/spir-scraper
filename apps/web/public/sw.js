// Service worker: notifications even when the page is closed, and an offline
// page instead of the browser's error when the phone has no connection.
// Nothing else is cached: the dashboard always shows live data.

const OFFLINE_CACHE = "scrapers-offline-v1";
const OFFLINE_FILES = ["/offline.html", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.addAll(OFFLINE_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Page loads only (not API calls or assets): the network, or the offline page.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match("/offline.html").then((r) => r || Response.error()),
    ),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Scrapers", body: "", url: "/" };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    // Plain-text push: keep the defaults.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      dir: "rtl",
      lang: "ar",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin) && "focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
