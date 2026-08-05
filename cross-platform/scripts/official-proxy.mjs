const apiRoot = 'https://monster-siren.hypergryph.com/api';
const catalogTtlMs = 90_000;
const staleCatalogTtlMs = 30 * 60_000;

let catalogCache;
let catalogRequest;

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Type',
    Vary: 'Origin'
  };
}

export function sendJson(response, status, body, extraHeaders = {}) {
  response.statusCode = status;
  for (const [name, value] of Object.entries({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders
  })) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

export function validSongId(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ''));
}

export function safeFileName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export async function requestOfficial(path) {
  const response = await fetch(`${apiRoot}${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Siren-Records-Web-Proxy/1.0'
    },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`官网返回 HTTP ${response.status}`);
  return response.json();
}

export async function getCatalog() {
  const now = Date.now();
  if (catalogCache && now - catalogCache.updatedAt < catalogTtlMs) return catalogCache.payload;
  if (catalogRequest) return catalogRequest;
  catalogRequest = (async () => {
    try {
      const [albums, songs] = await Promise.all([
        requestOfficial('/albums'),
        requestOfficial('/songs')
      ]);
      const payload = { albums, songs };
      catalogCache = { payload, updatedAt: Date.now() };
      return payload;
    } catch (error) {
      if (catalogCache && Date.now() - catalogCache.updatedAt < staleCatalogTtlMs) return catalogCache.payload;
      throw error;
    } finally {
      catalogRequest = undefined;
    }
  })();
  return catalogRequest;
}

export async function fetchOfficialAudio(id) {
  let song = (await requestOfficial(`/song/${encodeURIComponent(id)}`))?.data;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sourceUrl = song?.sourceUrl;
    if (typeof sourceUrl !== 'string' || !sourceUrl) throw new Error('歌曲没有可用音频地址');
    const source = new URL(sourceUrl);
    if (source.protocol !== 'https:') throw new Error('歌曲音频地址不安全');

    const upstream = await fetch(source, {
      headers: { Accept: 'audio/wav, audio/*;q=0.9, */*;q=0.1' },
      signal: AbortSignal.timeout(60_000)
    });
    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (upstream.ok && upstream.body && !contentType.includes('text/html')) return { song, upstream };
    if (attempt === 0 && [401, 403, 404].includes(upstream.status)) {
      song = (await requestOfficial(`/song/${encodeURIComponent(id)}`))?.data;
      continue;
    }
    throw new Error(`音频请求失败：HTTP ${upstream.status}`);
  }
  throw new Error('音频请求失败');
}

export function findAlbumName(catalog, albumCid) {
  const rows = Array.isArray(catalog?.albums?.data) ? catalog.albums.data : [];
  const album = rows.find((entry) => String(entry?.cid ?? '') === String(albumCid ?? ''));
  return typeof album?.name === 'string' ? album.name : '';
}

export function audioFileName(song, albumName, fallback) {
  const name = safeFileName(`[${albumName || '塞壬唱片'}] ${song?.name || fallback}`, fallback);
  return `${name}.wav`;
}
