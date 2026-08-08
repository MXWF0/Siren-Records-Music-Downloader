import { Readable } from 'node:stream';
import {
  audioExtension,
  audioFileName,
  corsHeaders,
  enforceRequestPolicy,
  fetchOfficialAudio,
  findAlbumName,
  getCatalog,
  sendJson,
  validRangeHeader,
  validSongId
} from '../../scripts/official-proxy.mjs';

export default async function handler(request, response) {
  if (!enforceRequestPolicy(request, response, 'audio', { count: request.method === 'GET' })) return;
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    Object.entries(corsHeaders(request)).forEach(([name, value]) => response.setHeader(name, value));
    response.end();
    return;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: '仅支持 GET 下载请求' }, request, { Allow: 'GET, OPTIONS' });
    return;
  }

  let urlId = '';
  try { urlId = new URL(request.url || '/', 'http://localhost').searchParams.get('id') || ''; } catch { /* invalid URL */ }
  const rawId = request.query?.id || urlId || request.url?.split('/').pop()?.split('?')[0] || '';
  const id = Array.isArray(rawId) ? rawId[0] : String(rawId);
  if (!validSongId(id)) {
    sendJson(response, 400, { error: '歌曲编号无效' }, request);
    return;
  }

  const controller = new AbortController();
  response.on('close', () => controller.abort());
  try {
    const { song, sourceUrl, upstream } = await fetchOfficialAudio(id, {
      signal: controller.signal,
      range: validRangeHeader(request.headers?.range)
    });
    let albumName = typeof song?.albumName === 'string' ? song.albumName : '';
    if (!albumName && song?.albumCid) {
      try { albumName = findAlbumName(await getCatalog(), song.albumCid); } catch { /* filename only */ }
    }
    const contentType = upstream.headers.get('content-type') || 'audio/wav';
    const extension = audioExtension(contentType, sourceUrl);
    const fileName = audioFileName(song, albumName, id, extension);
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    const acceptRanges = upstream.headers.get('accept-ranges');
    response.statusCode = upstream.status === 206 ? 206 : 200;
    for (const [name, value] of Object.entries({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${id}.${extension}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ...(contentLength ? { 'Content-Length': contentLength } : {}),
      ...(contentRange ? { 'Content-Range': contentRange } : {}),
      ...(acceptRanges ? { 'Accept-Ranges': acceptRanges } : { 'Accept-Ranges': 'bytes' }),
      'Cache-Control': 'no-store',
      ...corsHeaders(request)
    })) response.setHeader(name, value);
    if (!upstream.body) {
      response.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body);
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    const reason = error instanceof Error ? error.message : '未知网络错误';
    sendJson(response, 502, { error: `下载服务暂时不可用：${reason}` }, request);
  }
}
