import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  audioExtension,
  audioFileName,
  corsHeaders,
  enforceRequestPolicy,
  fetchOfficialAudio,
  fetchOfficialSong,
  findAlbumName,
  getCatalog,
  sendJson,
  validRangeHeader,
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

function endPreflight(request, response, scope) {
  if (!enforceRequestPolicy(request, response, scope, { count: false })) return;
  response.writeHead(204, corsHeaders(request)).end();
}

async function handleCatalog(request, response, headOnly) {
  if (!enforceRequestPolicy(request, response, 'catalog', { count: !headOnly })) return;
  try {
    const payload = await getCatalog();
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      ...corsHeaders(request)
    });
    response.end(headOnly ? undefined : JSON.stringify(payload));
  } catch (error) {
    if (response.destroyed) return;
    const reason = error instanceof Error ? error.message : '未知网络错误';
    sendJson(response, 502, { error: `无法获取官网目录：${reason}` }, request);
  }
}

async function handleAudio(request, response, rawId) {
  if (!enforceRequestPolicy(request, response, 'audio')) return;
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
    const { song, sourceUrl, upstream } = await fetchOfficialAudio(id, {
      signal: controller.signal,
      range: validRangeHeader(request.headers.range)
    });
    let albumName = typeof song?.albumName === 'string' ? song.albumName : '';
    if (!albumName && song?.albumCid) {
      try {
        albumName = findAlbumName(await getCatalog(), song.albumCid);
      } catch {
        // Album metadata only affects the suggested filename.
      }
    }

    const contentType = upstream.headers.get('content-type') || 'audio/wav';
    const extension = audioExtension(contentType, sourceUrl);
    const fileName = audioFileName(song, albumName, id, extension);
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    const acceptRanges = upstream.headers.get('accept-ranges');
    response.writeHead(upstream.status === 206 ? 206 : 200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${id}.${extension}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ...(contentLength ? { 'Content-Length': contentLength } : {}),
      ...(contentRange ? { 'Content-Range': contentRange } : {}),
      ...(acceptRanges ? { 'Accept-Ranges': acceptRanges } : { 'Accept-Ranges': 'bytes' }),
      'Cache-Control': 'no-store',
      ...corsHeaders(request)
    });
    const stream = Readable.fromWeb(upstream.body);
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    if (response.destroyed || response.headersSent) {
      response.destroy();
      return;
    }
    const reason = error instanceof Error ? error.message : '未知网络错误';
    sendJson(response, 502, { error: `下载服务暂时不可用：${reason}` }, request);
  }
}

async function handleSong(request, response, id) {
  if (!enforceRequestPolicy(request, response, 'catalog')) return;
  if (!validSongId(id)) {
    sendJson(response, 400, { error: '歌曲编号无效' }, request);
    return;
  }
  try {
    sendJson(response, 200, { data: await fetchOfficialSong(id) }, request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知网络错误';
    sendJson(response, 502, { error: `无法获取歌曲详情：${reason}` }, request);
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
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
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

  if (method === 'OPTIONS' && (audioRoute || catalogRoute || songRoute)) {
    endPreflight(request, response, audioRoute ? 'audio' : 'catalog');
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', ...corsHeaders(request) }).end();
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
