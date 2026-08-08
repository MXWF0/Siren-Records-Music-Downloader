const apiRoot = 'https://monster-siren.hypergryph.com/api';
const catalogTtlMs = 90_000;
const staleCatalogTtlMs = 30 * 60_000;
const defaultRateLimitWindowMs = 60_000;
const defaultAllowedOrigins = [
  'https://mxwf0.github.io',
  'http://127.0.0.1:1420',
  'http://localhost:1420',
  'http://127.0.0.1:4173',
  'http://localhost:4173'
];

let catalogCache;
let catalogRequest;
const rateLimitBuckets = new Map();

function parseList(value, fallback = []) {
  const values = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return values.length ? values : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getHeader(request, name) {
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function requestOrigin(request) {
  return getHeader(request, 'origin').trim().replace(/\/+$/, '');
}

function requestHostOrigin(request) {
  const host = getHeader(request, 'x-forwarded-host') || getHeader(request, 'host');
  if (!host) return '';
  const protocol = (getHeader(request, 'x-forwarded-proto') || (request?.socket?.encrypted ? 'https' : 'http'))
    .split(',')[0]
    .trim();
  return `${protocol}://${host}`;
}

function clientAddress(request) {
  const forwarded = getHeader(request, 'x-forwarded-for').split(',')[0].trim();
  const value = forwarded || getHeader(request, 'cf-connecting-ip') || request?.socket?.remoteAddress || 'unknown';
  return String(value).slice(0, 96);
}

function allowedOrigins() {
  return new Set(parseList(process.env.SIREN_ALLOWED_ORIGINS, defaultAllowedOrigins));
}

export function isOriginAllowed(request) {
  const origin = requestOrigin(request);
  if (!origin) return true;
  if (origin === requestHostOrigin(request)) return true;
  if (origin === 'null') return process.env.SIREN_ALLOW_NULL_ORIGIN === '1';
  return allowedOrigins().has(origin);
}

export function corsHeaders(request) {
  const origin = requestOrigin(request);
  const allowOrigin = origin && isOriginAllowed(request) ? origin : '';
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range, Content-Type, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin'
  };
}

export function sendJson(response, status, body, request, extraHeaders = {}) {
  response.statusCode = status;
  for (const [name, value] of Object.entries({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(request),
    ...extraHeaders
  })) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

/**
 * Small in-memory limiter for accidental abuse. Serverless instances do not
 * share memory, so production deployments may replace this with a durable
 * provider-level limiter without changing the API contract.
 */
export function consumeRateLimit(key, limit, windowMs, now = Date.now()) {
  const current = rateLimitBuckets.get(key);
  const bucket = !current || now >= current.resetAt
    ? { count: 0, resetAt: now + windowMs }
    : current;
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt
  };
}

export function resetRateLimitsForTests() {
  rateLimitBuckets.clear();
}

export function enforceRequestPolicy(request, response, scope, { count = true } = {}) {
  if (!isOriginAllowed(request)) {
    sendJson(response, 403, { error: '当前网站没有权限使用此下载接口' }, request);
    return false;
  }
  if (!count) return true;

  const windowMs = positiveInteger(process.env.SIREN_RATE_LIMIT_WINDOW_MS, defaultRateLimitWindowMs);
  const limit = scope === 'audio'
    ? positiveInteger(process.env.SIREN_AUDIO_RATE_LIMIT, 8)
    : positiveInteger(process.env.SIREN_CATALOG_RATE_LIMIT, 60);
  const rate = consumeRateLimit(`${scope}:${clientAddress(request)}`, limit, windowMs);
  response.setHeader('X-RateLimit-Limit', String(rate.limit));
  response.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  response.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));
  if (rateLimitBuckets.size > 5000) {
    for (const [key, value] of rateLimitBuckets) {
      if (Date.now() >= value.resetAt) rateLimitBuckets.delete(key);
    }
  }
  if (rate.allowed) return true;

  const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
  sendJson(response, 429, { error: `请求过于频繁，请在 ${retryAfter} 秒后重试` }, request, {
    'Retry-After': String(retryAfter)
  });
  return false;
}

export function validSongId(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(value || ''));
}

export function validRangeHeader(value) {
  const range = String(value || '').trim();
  return /^bytes=(?:\d+-\d*|-\d+)$/.test(range) ? range : '';
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

function isAllowedAudioUrl(value) {
  const url = new URL(value);
  const allowedHosts = parseList(process.env.SIREN_AUDIO_HOSTS, ['hycdn.cn']);
  const hostname = url.hostname.toLowerCase();
  const hostAllowed = allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  return url.protocol === 'https:' && !url.username && !url.password && hostAllowed;
}

function withTimeout(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function requestOfficial(path, { signal } = {}) {
  const response = await fetch(`${apiRoot}${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Siren-Records-Web-Proxy'
    },
    signal: withTimeout(signal, 20_000)
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

export async function fetchOfficialAudio(id, { signal, range = '' } = {}) {
  let song = (await requestOfficial(`/song/${encodeURIComponent(id)}`, { signal }))?.data;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sourceUrl = song?.sourceUrl;
    if (typeof sourceUrl !== 'string' || !sourceUrl) throw new Error('歌曲暂时没有可用的音频地址');
    if (!isAllowedAudioUrl(sourceUrl)) throw new Error('官网返回了不受信任的音频地址');

    // The timeout protects connection establishment; cancellation remains
    // attached to the caller while a large audio stream is being forwarded.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), 20_000);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let upstream;
    try {
      upstream = await fetch(sourceUrl, {
        headers: {
          Accept: 'audio/wav, audio/*;q=0.9, */*;q=0.1',
          ...(validRangeHeader(range) ? { Range: validRangeHeader(range) } : {})
        },
        signal: requestSignal
      });
    } finally {
      clearTimeout(timer);
    }
    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const contentLength = Number(upstream.headers.get('content-length')) || 0;
    const maxBytes = positiveInteger(process.env.SIREN_MAX_AUDIO_BYTES, 1024 * 1024 * 1024);
    if (contentLength > maxBytes) throw new Error('音频文件超过代理允许的大小');
    if (upstream.ok && upstream.body && !/text\/html|application\/json/.test(contentType)) {
      return { song, sourceUrl, upstream };
    }
    if (attempt === 0 && [401, 403, 404].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => undefined);
      song = (await requestOfficial(`/song/${encodeURIComponent(id)}`, { signal }))?.data;
      continue;
    }
    throw new Error(`官网音频服务返回 HTTP ${upstream.status}`);
  }
  throw new Error('官网音频服务暂时不可用');
}

/** Return current public metadata without exposing the short-lived audio URL. */
export async function fetchOfficialSong(id, { signal } = {}) {
  const song = (await requestOfficial(`/song/${encodeURIComponent(id)}`, { signal }))?.data;
  if (!song || typeof song !== 'object') throw new Error('歌曲详情暂时不可用');
  const { sourceUrl: _sourceUrl, ...safeSong } = song;
  return safeSong;
}

export function findAlbumName(catalog, albumCid) {
  const rows = Array.isArray(catalog?.albums?.data) ? catalog.albums.data : [];
  const album = rows.find((entry) => String(entry?.cid ?? '') === String(albumCid ?? ''));
  return typeof album?.name === 'string' ? album.name : '';
}

export function audioExtension(contentType, sourceUrl = '') {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('flac')) return 'flac';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('aac')) return 'aac';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  const pathExtension = String(sourceUrl).split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return pathExtension?.toLowerCase() || 'wav';
}

export function audioFileName(song, albumName, fallback, extension = 'wav') {
  const name = safeFileName(`[${albumName || '塞壬唱片'}] ${song?.name || fallback}`, fallback);
  return `${name}.${extension}`;
}
