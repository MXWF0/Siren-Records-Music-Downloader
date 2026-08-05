import { Readable } from 'node:stream';
import {
  audioFileName,
  corsHeaders,
  fetchOfficialAudio,
  findAlbumName,
  getCatalog,
  sendJson,
  validSongId
} from '../../scripts/official-proxy.mjs';

export default async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    Object.entries(corsHeaders()).forEach(([name, value]) => response.setHeader(name, value));
    response.end();
    return;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method Not Allowed' }, { Allow: 'GET, OPTIONS' });
    return;
  }

  let urlId = '';
  try { urlId = new URL(request.url || '/', 'http://localhost').searchParams.get('id') || ''; } catch { /* invalid URL */ }
  const rawId = request.query?.id || urlId || request.url?.split('/').pop()?.split('?')[0] || '';
  const id = Array.isArray(rawId) ? rawId[0] : String(rawId);
  if (!validSongId(id)) {
    sendJson(response, 400, { error: '歌曲编号无效' });
    return;
  }

  try {
    const { song, upstream } = await fetchOfficialAudio(id);
    let albumName = typeof song?.albumName === 'string' ? song.albumName : '';
    if (!albumName && song?.albumCid) {
      try { albumName = findAlbumName(await getCatalog(), song.albumCid); } catch { /* filename only */ }
    }
    const fileName = audioFileName(song, albumName, id);
    const contentType = upstream.headers.get('content-type') || 'audio/wav';
    const contentLength = upstream.headers.get('content-length');
    response.statusCode = 200;
    for (const [name, value] of Object.entries({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${id}.wav"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ...(contentLength ? { 'Content-Length': contentLength } : {}),
      'Cache-Control': 'no-store',
      ...corsHeaders()
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
    sendJson(response, 502, { error: `无法下载歌曲：${reason}` });
  }
}
