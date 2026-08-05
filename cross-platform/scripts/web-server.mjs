import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const projectDirectory = resolve(scriptDirectory, '..');
const distDirectory = resolve(projectDirectory, 'dist');
const apiRoot = 'https://monster-siren.hypergryph.com/api';
const platformPort = process.env.PORT || '';
const host = process.env.SIREN_WEB_HOST || (platformPort ? '0.0.0.0' : '127.0.0.1');
const port = Number.parseInt(process.env.SIREN_WEB_PORT || platformPort || '4173', 10);
const catalogTtlMs = 90_000;
const staleCatalogTtlMs = 30 * 60_000;
const allowOrigin = process.env.SIREN_WEB_ALLOW_ORIGIN || '*';

let catalogCache;
let catalogRequest;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2'
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Type',
    Vary: 'Origin'
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders()
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function safeFileName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function validSongId(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

async function requestOfficial(path) {
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

async function getCatalog() {
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

async function handleCatalog(response) {
  try {
    const payload = await getCatalog();
    sendJson(response, 200, payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知网络错误';
    sendError(response, 502, `无法获取官网目录：${reason}`);
  }
}

async function fetchOfficialAudio(id) {
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
      // CDN authorization paths rotate. Fetch the song endpoint again before reporting a failure.
      song = (await requestOfficial(`/song/${encodeURIComponent(id)}`))?.data;
      continue;
    }
    throw new Error(`音频请求失败：HTTP ${upstream.status}`);
  }
  throw new Error('音频请求失败');
}

async function handleAudio(response, encodedId) {
  let id;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    sendError(response, 400, '歌曲编号无效');
    return;
  }
  if (!validSongId(id)) {
    sendError(response, 400, '歌曲编号无效');
    return;
  }

  try {
    const { song, upstream } = await fetchOfficialAudio(id);

    let albumName = typeof song?.albumName === 'string' ? song.albumName : '';
    if (!albumName && song?.albumCid) {
      try {
        const catalog = await getCatalog();
        const albumRows = Array.isArray(catalog?.albums?.data) ? catalog.albums.data : [];
        const album = albumRows.find((entry) => String(entry?.cid ?? '') === String(song.albumCid));
        if (typeof album?.name === 'string') albumName = album.name;
      } catch {
        // The song endpoint is sufficient to download; a missing album name only affects the filename.
      }
    }
    const name = safeFileName(`[${albumName || '塞壬唱片'}] ${song?.name || id}`, id);
    const type = upstream.headers.get('content-type') || 'audio/wav';
    const length = upstream.headers.get('content-length');
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${id}.wav"; filename*=UTF-8''${encodeURIComponent(name)}.wav`,
      ...(length ? { 'Content-Length': length } : {}),
      'Cache-Control': 'no-store',
      ...corsHeaders()
    });
    const stream = Readable.fromWeb(upstream.body);
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    if (response.destroyed) return;
    if (!response.headersSent) {
      const reason = error instanceof Error ? error.message : '未知网络错误';
      sendError(response, 502, `无法下载歌曲：${reason}`);
    } else {
      response.destroy();
    }
  }
}

async function serveStatic(response, pathname, headOnly) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  let filePath;
  try {
    filePath = resolve(distDirectory, `.${decodeURIComponent(requestPath)}`);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (relative(distDirectory, filePath).startsWith('..')) {
    response.writeHead(403).end();
    return;
  }
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error('not file');
    const type = contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': metadata.size, 'Cache-Control': 'public, max-age=3600' });
    if (headOnly) response.end();
    else response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found. Run npm run build before starting the web server.');
  }
}

const server = createServer(async (request, response) => {
  const method = request.method || 'GET';
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  if (method === 'OPTIONS') {
    response.writeHead(204, corsHeaders()).end();
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', ...corsHeaders() }).end();
    return;
  }
  if (url.pathname === '/api/catalog') {
    if (method === 'HEAD') response.writeHead(200, corsHeaders()).end();
    else await handleCatalog(response);
    return;
  }
  if (url.pathname === '/api/audio') {
    if (method === 'HEAD') response.writeHead(405, { Allow: 'GET', ...corsHeaders() }).end();
    else await handleAudio(response, url.searchParams.get('id') || '');
    return;
  }
  if (url.pathname.startsWith('/api/audio/')) {
    if (method === 'HEAD') response.writeHead(405, { Allow: 'GET', ...corsHeaders() }).end();
    else await handleAudio(response, url.pathname.slice('/api/audio/'.length));
    return;
  }
  await serveStatic(response, url.pathname, method === 'HEAD');
});

server.listen(port, host, () => {
  console.log(`Siren Records Web is running at http://${host}:${port}`);
});
