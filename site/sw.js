// 域見夥伴：讓網站可以「加到主畫面」，訊號不好時也打得開。
// 網頁和名單資料：有網路就拿最新的並存一份，沒網路才用上次存的（只存看過的產業）。
// 地圖程式（版本固定）：存過就直接用。伺服器（狀態、登入）和地圖圖磚都不存。
const CACHE = 'shell-v2', DATA = 'data-v1', LIB = 'lib-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => ![CACHE, DATA, LIB].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

// 先拿網路的；網路失敗、或訊號太差 6 秒還沒回來而手機裡有存，就用存的（網路的回來後照樣更新存檔）
const fresh = (r, name, fallback) => {
  const net = fetch(r).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(name).then(x => x.put(r, c)); }
    return res;
  });
  const saved = () => caches.match(r).then(m => m || (fallback ? caches.match(fallback) : undefined));
  const slow = new Promise(ok => setTimeout(ok, 6000)).then(saved);
  return Promise.race([net, slow.then(m => m || net)]).catch(() => saved().then(m => m || Promise.reject(new Error('offline'))));
};

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (r.mode === 'navigate') e.respondWith(fresh(r, CACHE, './'));
  else if (u.origin === location.origin && u.pathname.includes('/data/') && u.pathname.endsWith('.json')) e.respondWith(fresh(r, DATA));
  else if (u.hostname === 'cdnjs.cloudflare.com' && u.pathname.includes('/leaflet/1.9.4/')) {
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(LIB).then(x => x.put(r, c)); }
      return res;
    })));
  }
});
