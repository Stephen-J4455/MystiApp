const CACHE_VERSION = "mystiwan-shell-v1";
const APP_SHELL = [
  "/assets/pwa-icon-192.png",
  "/assets/pwa-icon-512.png",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("supabase") ||
    url.pathname.startsWith("/auth/") ||
    request.headers.has("authorization")
  ) {
    return;
  }

  // Documents and application bundles stay network-first. The cached copy is
  // only a safe offline shell and never becomes the source for API data.
  if (request.mode === "navigate" || url.pathname.startsWith("/assets/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && request.mode === "navigate") {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() =>
          request.mode === "navigate"
            ? caches.match("/")
            : caches.match(request),
        ),
    );
    return;
  }

  // Explicitly leave all remaining same-origin dynamic requests alone.
});
