import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  audioExtension,
  audioFileName,
  corsHeaders,
  enforceRequestPolicy,
  resolveOfficialAudio,
  fetchOfficialSong,
  getCatalog,
  sendJson,
  validSongId
} from './official-proxy.mjs';

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const projectDirectory = resolve(scriptDirectory, '..');
const distDirectory = resolve(projectDirectory, 'dist');
const platformPort = process.env.PORT || '';
const host = process.env.SIREN_WEB_HOST || (platformPort ? '0.0.0.0' : '127.0.0.1');
const port = Number.parseInt(process.env.SIREN_WEB_PORT || platformPort || '4173', 10);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function handleHealth(response, headOnly) {
  const body = JSON.stringify({ status: 'ok', service: 'siren-records-web' });
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(headOnly ? undefined : body);
}

async function endPreflight(request, response, scope) {
  if (!await enforceRequestPolicy(request, response, scope, { count: false })) return;
  response.writeHead(204, corsHeaders(request)).end();
}

async function handleCatalog(request, response, headOnly) {
  if (!await enforceRequestPolicy(request, response, 'catalog', { count: !headOnly })) return;
  try {
    const payload = await getCatalog();
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
      'Vercel-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
      ...corsHeaders(request)
    });
    response.end(headOnly ? undefined : JSON.stringify(payload));
  } catch (error) {
    if (response.destroyed) return;
    console.error('[SirenRecords] catalog proxy failed', error);
    sendJson(response, 502, { error: '官网目录暂时不可用，请稍后重试' }, request);
  }
}

async function handleAudio(request, response, rawId) {
  if (!await enforceRequestPolicy(request, response, 'audio')) return;
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    sendJson(response, 400, { error: '歌曲编号无效' }, request);
    return;
  }
  if (!validSongId(id)) {
    sendJson(response, 400, { error: '歌曲编号无效' }, request);
    return;
  }

  const controller = new AbortController();
  response.on('close', () => controller.abort());
  try {
    const { song, sourceUrl } = await resolveOfficialAudio(id, { signal: controller.signal });
    const extension = audioExtension('', sourceUrl);
    const fileName = audioFileName(song, song?.albumName || '', id, extension);
    response.writeHead(307, {
      Location: sourceUrl,
      'Content-Disposition': `attachment; filename="${id}.${extension}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'X-Siren-Audio-Delivery': 'official-cdn-redirect',
      'Cache-Control': 'no-store',
      ...corsHeaders(request)
    });
    response.end();
  } catch (error) {
    if (response.destroyed || response.headersSent) {
      response.destroy();
      return;
    }
    console.error('[SirenRecords] audio URL resolution failed', error);
    sendJson(response, 502, { error: '音频下载服务暂时不可用，请稍后重试' }, request);
  }
}

async function handleSong(request, response, id) {
  if (!await enforceRequestPolicy(request, response, 'catalog')) return;
  if (!validSongId(id)) {
    sendJson(response, 400, { error: '歌曲编号无效' }, request);
    return;
  }
  try {
    sendJson(response, 200, { data: await fetchOfficialSong(id) }, request);
  } catch (error) {
    console.error('[SirenRecords] song proxy failed', error);
    sendJson(response, 502, { error: '歌曲详情暂时不可用，请稍后重试' }, request);
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
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': metadata.size,
      'Cache-Control': requestPath.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.hycdn.cn; font-src 'self'; connect-src 'self' https://*.hycdn.cn; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
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
  const audioRoute = url.pathname === '/api/audio' || url.pathname.startsWith('/api/audio/');
  const catalogRoute = url.pathname === '/api/catalog';
  const songRoute = url.pathname === '/api/song';
  const healthRoute = url.pathname === '/api/health';

  if (method === 'OPTIONS' && (audioRoute || catalogRoute || songRoute)) {
    await endPreflight(request, response, audioRoute ? 'audio' : 'catalog');
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', ...corsHeaders(request) }).end();
    return;
  }
  if (healthRoute) {
    handleHealth(response, method === 'HEAD');
    return;
  }
  if (catalogRoute) {
    await handleCatalog(request, response, method === 'HEAD');
    return;
  }
  if (songRoute) {
    await handleSong(request, response, url.searchParams.get('id') || '');
    return;
  }
  if (audioRoute) {
    if (method === 'HEAD') {
      sendJson(response, 405, { error: '音频接口仅支持 GET 请求' }, request, { Allow: 'GET, OPTIONS' });
      return;
    }
    const encodedId = url.pathname === '/api/audio'
      ? url.searchParams.get('id') || ''
      : url.pathname.slice('/api/audio/'.length);
    await handleAudio(request, response, encodedId);
    return;
  }
  await serveStatic(response, url.pathname, method === 'HEAD');
});

server.listen(port, host, () => {
  console.log(`Siren Records Web is running at http://${host}:${port}`);
});
