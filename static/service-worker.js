const CACHE_NAME = "pageandpine-shell-v16";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./app-icon.svg",
  "./vendor/jszip.min.js",
  "./vendor/epub.min.js",
  "./vendor/pdf.min.js",
  "./vendor/pdf.worker.min.js",
  "./vendor/dm-sans-400.ttf",
  "./vendor/dm-sans-500.ttf",
  "./vendor/dm-sans-600.ttf",
  "./vendor/dm-sans-700.ttf",
  "./vendor/playfair-display-400.ttf",
  "./vendor/playfair-display-500.ttf",
  "./vendor/playfair-display-600.ttf",
  "./vendor/playfair-display-700.ttf",
  "./vendor/opendyslexic-400.woff2",
  "./fonts/literata-variable.woff2",
  "./fonts/literata-italic-400.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "set-auth-required") {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const key = new Request(new URL("/__pageandpine_auth_required", self.location.origin));
      if (event.data.required) {
        await cache.put(key, new Response("true"));
        for (const request of await cache.keys()) {
          if (/^\/api\/books\/[^/]+\/file$/.test(new URL(request.url).pathname)) await cache.delete(request);
        }
      } else await cache.delete(key);
    })());
    return;
  }
  if (event.data?.type === "delete-book" && /^[a-f0-9]+$/i.test(event.data.bookId)) {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
      cache.delete(new Request(new URL(`/api/books/${event.data.bookId}/file`, self.location.origin)))
    ));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (/^\/api\/books\/[^/]+\/file$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        const authRequired = await cache.match(new Request(new URL("/__pageandpine_auth_required", self.location.origin)));
        if (authRequired) return new Response("Offline book access is disabled while PIN protection is enabled.", { status: 401 });
        const cached = await cache.match(request);
        if (cached) return cached;
        return new Response("This book has not been saved for offline reading on this device.", { status: 503 });
      }
    })());
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      return new Response(JSON.stringify({ detail: "The library server is offline." }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
