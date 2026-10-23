// The service worker: the app is installable, survives losing signal, and
// (v66) shows the flight alerts the Worker pushes straight to this phone.
const CACHE_NAME = "curbside-v68";

// Shared PDFs waiting for the page (Android's Share -> Curbside). Not
// versioned, and never cleared by an update: a share must survive one.
// import.js reads it as SHARED_CACHE; keep the two equal.
const SHARE_CACHE = "curbside-shared";

// Precached so the offline state has a shell to render. "/" and not
// "/index.html": the host redirects that to "/", and a redirected response
// handed to a navigation is refused by the browser.
const CORE_ASSETS = [
  "/",
  "/app.js",
  "/motion.js",
  "/messages.js",
  "/assignments.js",
  "/import.js",
  "/manifest.json",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  // The guide opens with no signal too: a tester reads it on the way.
  "/guide/",
  // The sheet reader: a PDF read with no signal still becomes a run. Every
  // module of it, or the first import offline fails on a missing one
  // (sw.test.ts checks the list against public/importer/).
  "/importer/index.js",
  "/importer/pdf-reader.js",
  "/importer/inflate.js",
  "/importer/pdf-text.js",
  "/importer/python.js",
  "/importer/casefold.js",
  "/importer/sheet.js",
  "/importer/airlines.js",
];

// The shell is served network-first: a driver acting on a stale gate number is
// the failure this app exists to prevent, and cache-first meant a missed cache
// bump silently kept running old code on installed PWAs. Everything else stays
// cache-first, since those assets only change when their name does.
// How long the shell waits on the network before the cached copy serves.
const SHELL_WAIT_MS = 3000;

const SHELL = new Set(["/", "/index.html", "/app.js", "/motion.js", "/messages.js", "/assignments.js", "/import.js"]);

self.addEventListener("install", (event) => {
  // Past the HTTP cache: a stale copy from it would be kept until the next
  // version, and a stale reader reads sheets wrong.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    cache.addAll(CORE_ASSETS.map((path) => new Request(path, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== SHARE_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Settings' App version asks the worker in charge which one it is.
self.addEventListener("message", (event) => {
  if (event.data === "version") event.ports[0]?.postMessage(CACHE_NAME);
});

/**
 * An alert from the Worker (worker/src/webpush.ts): the notice as JSON,
 * { title, body, priority, at }. ALWAYS shown, whatever arrived: an iPhone
 * takes the subscription away from an app whose pushes show nothing, and a
 * push that could not be read still means something moved.
 */
function noticeOf(data) {
  let n = null;
  try { n = data ? data.json() : null; } catch (err) { n = null; }
  if (!n || typeof n !== "object" || typeof n.title !== "string" || !n.title) {
    return { title: "Curbside", options: { body: "Something changed. Open Curbside to see it.", icon: "/icon-192.png", badge: "/badge-96.png" } };
  }
  const options = {
    body: typeof n.body === "string" ? n.body : "",
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    // Quiet news (a gate to expect, a tester's note) makes no sound, as it
    // made none through ntfy; anything the driver acts on does.
    silent: typeof n.priority === "number" && n.priority <= 2,
  };
  // When it was sent, not when the phone came back from a dead zone.
  if (typeof n.at === "number") options.timestamp = n.at;
  return { title: n.title, options };
}

self.addEventListener("push", (event) => {
  const { title, options } = noticeOf(event.data);
  event.waitUntil(self.registration.showNotification(title, options));
});

// A tap opens the app: the one already open, else a new one. The run's page
// shows what the alert said, with the times as they now stand. The app is
// "/": the guide or the testers' page open in a tab is not it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
    const app = open.find((c) => {
      const url = new URL(c.url);
      return url.origin === self.location.origin && url.pathname === "/";
    });
    return app && "focus" in app ? app.focus() : self.clients.openWindow("/");
  }));
});

/**
 * Share -> Curbside (manifest.json's share_target) arrives as a POST of the
 * files. They are kept for the page, which reads them on the device like any
 * picked file, and the share is answered with the app: 303, so a reload is a
 * plain GET and never shares again.
 */
async function takeShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const stamp = Date.now();
    let n = 0;
    for (const file of form.getAll("sheets")) {
      if (!file || typeof file === "string") continue;
      await cache.put(`/shared/${stamp}-${String(n++).padStart(3, "0")}`, new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name || "shared.pdf"),
        },
      }));
    }
  } catch (err) {
    // Nothing kept: the page, opened by the share, says nothing arrived.
    console.error("Share: couldn't keep the files:", err);
  }
  return Response.redirect("/?shared=1", 303);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === "POST" && url.origin === self.location.origin && url.pathname === "/share-target") {
    event.respondWith(takeShare(request));
    return;
  }
  if (request.method !== "GET") return;

  // Let the Worker API and cross-origin requests (fonts) go straight to the network;
  // the app handles its own offline fallback for data.
  if (url.origin !== self.location.origin) return;

  const isShell = request.mode === "navigate" || SHELL.has(url.pathname);

  if (isShell) {
    const network = fetch(request)
      .then((response) => {
        // Only the app itself is kept. A wifi login page answers 200 after a
        // redirect, and a 404 or 5xx is not the shell either; caching one
        // would break the next offline launch. The last good copy serves.
        if (!response.ok || response.redirected || response.type !== "basic") {
          return caches.match(request).then((cached) => cached || response);
        }
        const copy = response.clone();
        return caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).then(() => response);
      });
    // A late answer still refreshes the cache after the cached copy was served.
    if (event.waitUntil) event.waitUntil(network.catch(() => {}));
    event.respondWith(
      caches.match(request).then((cached) => {
        if (!cached) return network.catch(() => caches.match("/"));
        // One bar that neither answers nor fails: the last good copy after a
        // few seconds, not a blank screen until the browser gives up.
        const slow = new Promise((resolve) => setTimeout(() => resolve(cached), SHELL_WAIT_MS));
        return Promise.race([network.catch(() => cached), slow]);
      })
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
