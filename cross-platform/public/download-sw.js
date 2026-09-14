/*
 * Browser-managed download bridge.
 *
 * The response body is fetched and streamed on the user's device. This lets
 * Safari, Firefox and mobile browsers receive an attachment response with the
 * catalogue filename without sending audio bytes through the application
 * server or retaining the whole file in a Blob.
 */
const routeName = '__siren_download__';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function safeFilename(value) {
  return String(value || 'siren-audio')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'siren-audio';
}

function encodedDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function streamDownload(request) {
  const requestUrl = new URL(request.url);
  const sourceValue = requestUrl.searchParams.get('source') || '';
  const filename = safeFilename(requestUrl.searchParams.get('filename'));
  let source;
  try {
    source = new URL(sourceValue);
    if (!['https:', 'http:'].includes(source.protocol)) throw new Error('invalid protocol');
  } catch {
    return new Response('下载地址无效，请返回应用后重试。', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  try {
    const range = request.headers.get('range');
    const upstream = await fetch(source.href, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      headers: range && /^bytes=(?:\d+-\d*|-\d+)$/.test(range) ? { Range: range } : undefined
    });
    if (!upstream.ok || !upstream.body) {
      return new Response(`下载服务返回 HTTP ${upstream.status}，请稍后重试。`, {
        status: upstream.status || 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    const headers = new Headers({
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Disposition': encodedDisposition(filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    const length = upstream.headers.get('content-length');
    if (length) headers.set('Content-Length', length);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.error('[SirenRecords] browser download stream failed', error);
    return new Response('网络请求失败，请返回应用后重试。', {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.split('/').pop() !== routeName || event.request.method !== 'GET') return;
  event.respondWith(streamDownload(event.request));
});
