// Offline shell. Caches only Lueur's own files; personal data lives in IndexedDB, not here.
const CACHE = "lueur-shell-v2";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "icon.svg",
  "js/app.js", "js/engine.js", "js/store.js", "js/demo.js", "js/importers.js", "js/sensing.js", "js/slm.js", "js/native.js", "js/vendor/capacitor.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k.startsWith("lueur-shell")).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // network first so updates land, cache as the offline fallback
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
