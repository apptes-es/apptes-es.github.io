/* Service worker de TES Test: la app funciona sin conexión.
   Estrategia: primero la red (para recibir siempre lo último) y, si no hay, la copia guardada. */
const CACHE = 'tes-test-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'data.js', 'store.js', 'pdf.js', 'cloud.js', 'bank.js', 'fun.js', 'app.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k !== CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
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
