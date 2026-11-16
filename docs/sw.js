// Offline support. App files: network first (updates show up at once), cache as fallback.
// Pinned CDN files (ffmpeg core, transformers.js): cache first, since a pinned version never changes.
// Whisper model files are cached by transformers.js itself, so they're left alone here.
const SHELL = "cm-shell-v6", CDN = "cm-cdn-v1";
const FILES = ["./", "index.html", "app.js", "formula.js", "formula.json", "asr-worker.js", "manifest.json", "icon.svg",
  "icon-180.png", "icon-512.png", "fonts/Montserrat-Black.ttf", "studio.js", "zip.js",
  "fonts/ui/archivo-400-800.woff2", "fonts/ui/instrumentsans-400-700.woff2", "fonts/ui/ibmplexmono-400.woff2", "fonts/ui/ibmplexmono-500.woff2",
  "vendor/ffmpeg/index.js", "vendor/ffmpeg/classes.js", "vendor/ffmpeg/const.js", "vendor/ffmpeg/errors.js",
  "vendor/ffmpeg/types.js", "vendor/ffmpeg/utils.js", "vendor/ffmpeg/worker.js",
  "vendor/util/index.js", "vendor/util/const.js", "vendor/util/errors.js", "vendor/util/types.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("cm-") && k !== SHELL && k !== CDN).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const pinned = u => u.hostname === "cdn.jsdelivr.net" && /@\d+\.\d+\.\d+/.test(u.pathname);

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (/\.(mp4|mov|m4a|webm)$/i.test(u.pathname) || /\/(api|files)\//.test(u.pathname)) return;   // never cache media or app data
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))));
  } else if (pinned(u)) {
    e.respondWith(caches.open(CDN).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
  }
});
