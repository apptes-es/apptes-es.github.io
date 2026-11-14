/* Service worker de TES Test: la app funciona sin conexión.
   Estrategia: primero la red (para recibir siempre lo último) y, si no hay, la copia guardada. */
const CACHE = 'tes-test-v15';   // cambiar a la vez que APP_VERSION en app.js
const SHELL = ['./', 'index.html', 'styles.css', 'data.js', 'store.js', 'pdf.js', 'cloud.js', 'bank.js', 'fun.js', 'app.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k !== CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
    // Se avisa a la app abierta de qué versión hay: si es más nueva que la suya, ofrece actualizar
    .then(()=>self.clients.matchAll({ type: 'window' }))
    .then(list=>list.forEach(c=>c.postMessage({ type: 'sw-version', v: CACHE }))));
});

// Notificaciones push (retos y resultados de duelos)
self.addEventListener('push', e=>{
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(_){ d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'TES Test', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e=>{
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list=>{
    for(const c of list){
      if(c.url.indexOf(self.registration.scope) === 0){ c.postMessage({ type: 'open-duels' }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;   // Supabase y fuentes van directos
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res=>{
      if(res && res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=>c.put(req, copy)); }
      return res;
    }).catch(()=>caches.match(req, { ignoreSearch: true }).then(r=>r || caches.match('index.html')))
  );
});
