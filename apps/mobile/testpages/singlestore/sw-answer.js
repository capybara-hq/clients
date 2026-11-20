// A deployment worker that answers every navigation itself: from its cache, else the network.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
  }
});
