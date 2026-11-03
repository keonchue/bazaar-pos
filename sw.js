/* ─────────────────────────────────────────────────────────────
   바자회 POS 서비스워커

   목적: GitHub Pages나 Firebase CDN(gstatic)이 잠깐 죽어도,
        와이파이가 끊겨도 앱 화면이 그대로 뜨게 만든다.
        (데이터 동기화는 Firestore의 오프라인 캐시가 따로 담당)

   전략: 캐시는 '평소에 쓰는 사본'이 아니라 '인터넷이 안 될 때 쓰는 예비품'이다.
        - 우리 파일(index.html 등) → 항상 네트워크 우선. 느리면 3.5초 후 캐시로 대체
        - Firebase SDK → 주소에 버전(10.12.2)이 박혀 있어 내용이 바뀔 일이 없으므로 캐시 우선

   덕분에 앱을 고쳐 배포할 때 이 파일에서 손댈 것이 없다.
   (예전 방식은 배포할 때마다 VERSION을 올려야 했고, 잊으면 낡은 화면이 남았다)
   ───────────────────────────────────────────────────────────── */

const CACHE = 'bazaar-pos';
const NET_TIMEOUT = 3500;   // 이 시간 안에 응답이 없으면 캐시본으로 넘어간다

// 앱 껍데기 — 이것만 있으면 오프라인에서도 화면이 뜬다
const APP_SHELL = [
  './',
  './index.html',
  './firebase-config.js',
  './ledger.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

// Firebase SDK (외부 CDN) — 캐시해두지 않으면 CDN 장애 시 앱이 아예 안 뜬다
const FIREBASE_VER = '10.12.2';
const VENDOR = [
  'firebase-app.js',
  'firebase-auth.js',
  'firebase-firestore.js',
].map(f => `https://www.gstatic.com/firebasejs/${FIREBASE_VER}/${f}`);

// 실시간 통신 경로 — 절대 캐시하면 안 되는 도메인
const NEVER_CACHE = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 앱 껍데기는 반드시 받아야 함
    await cache.addAll(APP_SHELL);
    // 외부 CDN은 실패해도 설치를 막지 않는다 (다음 온라인 접속 때 다시 시도)
    await Promise.all(VENDOR.map(url =>
      cache.add(new Request(url, { mode: 'cors' })).catch(() => {})
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 예전 방식이 남긴 seojeokbu-pos-v1 / -v2 같은 보관함 정리
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// 네트워크를 기다리되, 너무 느리면 캐시본으로 즉시 넘어간다.
// (인터넷이 '끊긴' 것보다 '느린' 상황이 매대에서는 더 위험하다)
//
// cache:'no-store' 가 꼭 필요하다. 이게 없으면 네트워크 우선이어도 그 fetch 가 브라우저
// HTTP 캐시에 먼저 걸린다. GitHub Pages 가 `Cache-Control: max-age=600` 을 보내므로
// 배포한 지 10분 안에는 새로고침을 해도 옛 파일이 그대로 나왔다.
// (2026-09-01 에 실제로 겪음 — 새 화면이 안 떠서 캐시 우회 주소로 열어야 보였다)
async function networkFirst(req, fallbackKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req, { cache: 'no-store' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT)),
    ]);
    if (res && res.ok) cache.put(fallbackKey || req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(fallbackKey || req) || await cache.match(req);
    if (hit) return hit;
    throw new Error('offline and not cached');
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (NEVER_CACHE.some(h => url.hostname.endsWith(h))) return;  // 네트워크로 직행

  // 페이지 이동
  if (req.mode === 'navigate') {
    event.respondWith(
      networkFirst(req, './index.html').catch(() => new Response(
        '오프라인 상태이고 저장된 앱도 없습니다.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      ))
    );
    return;
  }

  /* 글꼴도 주소가 곧 내용이라 캐시 우선으로 둔다. 안 그러면 오프라인 첫 화면에서
     글꼴만 시스템 글꼴로 튀어 글자 폭이 달라지고 표가 흔들린다. */
  const isVendor = url.hostname === 'www.gstatic.com'
                || url.hostname === 'fonts.googleapis.com'
                || url.hostname === 'fonts.gstatic.com'
                // Pretendard — 주소에 버전(v1.3.9)이 박혀 있다. jsdelivr 의 다른 경로는 안 받는다
                || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/gh/orioncactus/pretendard@'));
  const isOwn = url.origin === self.location.origin;
  if (!isVendor && !isOwn) return;

  // Firebase SDK·글꼴: 주소가 곧 버전이라 내용이 바뀌지 않는다 → 캐시 우선(빠름)
  if (isVendor) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // 우리 파일: 항상 최신 우선, 안 되면 캐시본
  event.respondWith(
    networkFirst(req).catch(() => new Response('', { status: 504 }))
  );
});
