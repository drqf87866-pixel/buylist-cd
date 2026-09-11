"use strict";

// Version erhoet (v2 -> v3), damit die bei allen Clients veralteten
// Shell-Caches (Cache-first, alte app.js) verworfen werden, sobald dieser
// Service Worker aktiv wird. Kuenftige Deployments brauchen keinen Bump mehr:
// die Shell wird unten stale-while-revalidate bedient.
const SHELL_CACHE = "buylist-shell-v4";
const SHELL_URLS = [
  "/",
  "/index.html",
  "/app.js",
  "/app-core.mjs",
  "/vendor/qrcode.js",
  "/style.css",
  "/data/categories.json",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  // addAll bricht beim ersten Fehler die gesamte Installation ab. Wir cachen
  // die Shell deshalb Datei fuer Datei und tolerieren einzelne Ausfaelle –
  // der Cache wird beim naechsten Ladevorgang nachgefuellt.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Strategie: Navigationen network-first mit Offline-Fallback (frische Shell
// bei jedem Laden). Statische Assets stale-while-revalidate: Cache sofort
// liefern, im Hintergrund aktualisieren – Updates kommen damit ohne manuelles
// Cache-Bumpen durch (spätestens beim nächsten Laden), Offline bleibt
// funktionsfaehig, 4xx/5xx landen niemals im Cache. /api/* und /ws nur Netz.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put("/index.html", copy)));
          }
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const refresh = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy)));
          }
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return refresh.then((res) => res || new Response("", { status: 504 }));
    })
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = { title: "Buylist", body: "", url: "/" };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
