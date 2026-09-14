const officialApiDefault = 'https://monster-siren.hypergryph.com/api';
const defaultOrigins = [
  'https://mxwf0.github.io',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:1420',
  'http://localhost:1420'
];
const defaultAudioHosts = ['hycdn.cn'];
const rateBuckets = new Map();

class UpstreamError extends Error {
  constructor(status) {
    super(`official upstream HTTP ${status}`);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

function listValue(value, fallback) {
  const values = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function allowedHost(urlValue, env) {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const hosts = listValue(env.AUDIO_HOSTS, defaultAudioHosts).map((host) => host.toLowerCase());
    const hostname = url.hostname.toLowerCase();
    return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function officialAsset(value, env) {
  const candidate = stringValue(value);
  return candidate && allowedHost(candidate, env) ? candidate : undefined;
}

function requestOrigin(request) {
  return (request.headers.get('Origin') || '').trim().replace(/\/+$/, '');
}

function originAllowed(request, env) {
  const origin = requestOrigin(request);
  if (!origin) return true;
  if (origin === new URL(request.url).origin) return true;
  if (origin === 'null') return env.ALLOW_NULL_ORIGIN === '1';
  return listValue(env.ALLOWED_ORIGINS, defaultOrigins).includes(origin);
}

function clientKey(request) {
  // CF-Connecting-IP is supplied by Cloudflare. Do not trust arbitrary
  // x-forwarded-for values from a public request.
  return request.headers.get('CF-Connecting-IP') || 'anonymous';
}

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
}

function corsHeaders(request, env) {
  const origin = requestOrigin(request);
  return {
    ...(origin && originAllowed(request, env) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range, Content-Type, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    Vary: 'Origin'
  };
}

function headersFor(request, env, extra = {}) {
  return new Headers({ ...securityHeaders(), ...corsHeaders(request, env), ...extra });
}

function jsonResponse(request, env, value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: headersFor(request, env, {
      'Content-Type': 'application/json; charset=utf-8',
      ...extra
    })
  });
}

function emptyResponse(request, env, status, extra = {}) {
  return new Response(null, { status, headers: headersFor(request, env, extra) });
}

function errorResponse(request, env, status, message, extra = {}) {
  return jsonResponse(request, env, { error: message }, status, {
    'Cache-Control': 'no-store',
    ...extra
  });
}

function rateLimit(request, env, scope) {
  const limit = positiveInteger(
    scope === 'audio' ? env.AUDIO_RATE_LIMIT : env.CATALOG_RATE_LIMIT,
    scope === 'audio' ? 8 : 60
  );
  const windowMs = positiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000);
  const key = `${scope}:${clientKey(request)}`;
  const now = Date.now();
  const current = rateBuckets.get(key);
  const bucket = !current || now >= current.resetAt
    ? { count: 0, resetAt: now + windowMs }
    : current;
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (now >= value.resetAt) rateBuckets.delete(bucketKey);
    }
  }
  const headers = {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, limit - bucket.count)),
    'X-RateLimit-Reset': String(Math.ceil(bucket.resetAt / 1000))
  };
  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { response: errorResponse(request, env, 429, `请求过于频繁，请在 ${retryAfter} 秒后重试`, { ...headers, 'Retry-After': String(retryAfter) }) };
  }
  return { headers };
}

async function fetchOfficial(path, request, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), positiveInteger(env.UPSTREAM_TIMEOUT_MS, 10_000));
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    const base = String(env.OFFICIAL_API_BASE || officialApiDefault).replace(/\/+$/, '');
    const response = await fetch(`${base}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Siren-Records-Cloudflare-Worker' },
      signal: controller.signal
    });
    if (!response.ok) throw new UpstreamError(response.status);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > positiveInteger(env.MAX_METADATA_BYTES, 4 * 1024 * 1024)) {
      throw new Error('official metadata response too large');
    }
    return response.json();
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  }
}

function songFields(value, env, includeSource = false) {
  if (!isRecord(value)) return null;
  const cid = stringValue(value.cid);
  if (!cid) return null;
  const result = {
    cid,
    name: stringValue(value.name) || cid,
    albumCid: stringValue(value.albumCid),
    ...(stringValue(value.albumName) ? { albumName: stringValue(value.albumName) } : {})
  };
  const artist = stringValue(value.artist);
  const artists = Array.isArray(value.artists)
    ? value.artists.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
  if (artist) result.artist = artist;
  else if (artists.length) result.artist = artists.join(' ');
  if (typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration > 0) result.duration = value.duration;
  for (const key of ['coverUrl', 'coverDeUrl', 'lyricUrl']) {
    const asset = officialAsset(value[key], env);
    if (asset) result[key] = asset;
  }
  if (includeSource) {
    const sourceUrl = officialAsset(value.sourceUrl, env);
    if (!sourceUrl) throw new Error('official audio URL is not allowed');
    result.sourceUrl = sourceUrl;
  }
  return result;
}

function albumFields(value, env) {
  if (!isRecord(value)) return null;
  const cid = stringValue(value.cid);
  if (!cid) return null;
  const coverUrl = officialAsset(value.coverUrl, env);
  const coverDeUrl = officialAsset(value.coverDeUrl, env);
  return {
    cid,
    name: stringValue(value.name) || cid,
    ...(coverUrl ? { coverUrl } : {}),
    ...(coverDeUrl ? { coverDeUrl } : {})
  };
}

async function loadCatalog(request, env) {
  const [albumsPayload, songsPayload] = await Promise.all([
    fetchOfficial('/albums', request, env),
    fetchOfficial('/songs', request, env)
  ]);
  const albumRows = Array.isArray(albumsPayload?.data) ? albumsPayload.data : [];
  const songRows = Array.isArray(songsPayload?.data?.list) ? songsPayload.data.list : [];
  const albums = albumRows.map((value) => albumFields(value, env)).filter(Boolean);
  const songs = songRows.map((value) => songFields(value, env)).filter(Boolean);
  if (!songs.length) throw new Error('official catalogue is empty');
  return { albums: { data: albums }, songs: { data: { list: songs } } };
}

async function loadSong(id, request, env, includeSource = false) {
  const payload = await fetchOfficial(`/song/${encodeURIComponent(id)}`, request, env);
  const song = songFields(payload?.data, env, includeSource);
  if (!song) throw new Error('official song metadata is invalid');
  return song;
}

function cacheKey(request, type) {
  const url = new URL(request.url);
  url.pathname = `/__siren_cache/${type}`;
  url.search = type === 'song' ? `?id=${encodeURIComponent(new URL(request.url).searchParams.get('id') || '')}` : '';
  return new Request(url.toString(), { method: 'GET' });
}

async function cachedJson(request, env, ctx, type, producer, cacheControl, requestHeaders = {}) {
  const key = cacheKey(request, type);
  const cached = await caches.default.match(key);
  if (cached) {
    return jsonResponse(request, env, await cached.json(), 200, {
      'Cache-Control': cacheControl,
      'X-Siren-Cache': 'HIT',
      ...requestHeaders
    });
  }
  const payload = await producer();
  const body = JSON.stringify(payload);
  const stored = new Response(body, {
    headers: headersFor(new Request(request.url), env, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl
    })
  });
  ctx.waitUntil(caches.default.put(key, stored));
  return jsonResponse(request, env, payload, 200, {
    'Cache-Control': cacheControl,
    'X-Siren-Cache': 'MISS',
    ...requestHeaders
  });
}

function safeFilename(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function audioExtension(sourceUrl) {
  const extension = String(sourceUrl).split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return extension?.toLowerCase() || 'wav';
}

function audioFilename(song, id, extension) {
  const album = safeFilename(song.albumName, '塞壬唱片');
  return `${safeFilename(`[${album}] ${song.name}`, id)}.${extension}`;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'OPTIONS') {
    return emptyResponse(request, env, 204);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(request, env, 405, '仅支持 GET、HEAD、OPTIONS 请求', { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (path === '/api/health') {
    return jsonResponse(request, env, { status: 'ok', service: 'siren-records-api', platform: 'cloudflare-workers' }, 200, { 'Cache-Control': 'no-store' });
  }
  if (path === '/api/catalog') {
    const limit = rateLimit(request, env, 'catalog');
    if (limit.response) return limit.response;
    if (request.method === 'HEAD') return emptyResponse(request, env, 200, { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300', ...limit.headers });
    return cachedJson(request, env, ctx, 'catalog', () => loadCatalog(request, env), 'public, max-age=60, stale-while-revalidate=300', limit.headers);
  }
  if (path === '/api/song') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return errorResponse(request, env, 400, '歌曲编号无效');
    const limit = rateLimit(request, env, 'catalog');
    if (limit.response) return limit.response;
    if (request.method === 'HEAD') return emptyResponse(request, env, 200, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600', ...limit.headers });
    return cachedJson(request, env, ctx, 'song', async () => ({ data: await loadSong(id, request, env) }), 'public, max-age=300, stale-while-revalidate=3600', limit.headers);
  }
  if (path === '/api/audio' || path.startsWith('/api/audio/')) {
    if (request.method !== 'GET') return errorResponse(request, env, 405, '音频接口仅支持 GET 请求', { Allow: 'GET, OPTIONS' });
    const id = path === '/api/audio'
      ? url.searchParams.get('id') || ''
      : decodeURIComponent(path.slice('/api/audio/'.length));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return errorResponse(request, env, 400, '歌曲编号无效');
    const limit = rateLimit(request, env, 'audio');
    if (limit.response) return limit.response;
    const song = await loadSong(id, request, env, true);
    const extension = audioExtension(song.sourceUrl);
    const filename = audioFilename(song, id, extension);
    return emptyResponse(request, env, 307, {
      Location: song.sourceUrl,
      'Content-Disposition': `attachment; filename="${id}.${extension}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Siren-Audio-Delivery': 'official-cdn-redirect',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...limit.headers
    });
  }
  return errorResponse(request, env, 404, 'Not found');
}

export default {
  async fetch(request, env, ctx) {
    if (!originAllowed(request, env)) return errorResponse(request, env, 403, '当前网站没有权限使用此接口');
    try {
      return await route(request, env, ctx);
    } catch (error) {
      const status = error?.name === 'AbortError' ? 504 : 502;
      console.error('[SirenRecords] Cloudflare Worker request failed', {
        path: new URL(request.url).pathname,
        status,
        errorType: error?.name || 'Error'
      }, error);
      return errorResponse(request, env, status, status === 504 ? '官网请求超时，请稍后重试' : '官网服务暂时不可用，请稍后重试');
    }
  }
};

export { rateBuckets, route };
