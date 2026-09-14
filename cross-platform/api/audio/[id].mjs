import {
  audioExtension,
  audioFileName,
  corsHeaders,
  enforceRequestPolicy,
  resolveOfficialAudio,
  sendJson,
  validSongId
} from '../../scripts/official-proxy.mjs';

export default async function handler(request, response) {
  if (!await enforceRequestPolicy(request, response, 'audio', { count: request.method === 'GET' })) return;
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
    const { song, sourceUrl } = await resolveOfficialAudio(id, { signal: controller.signal });
    const extension = audioExtension('', sourceUrl);
    const fileName = audioFileName(song, song?.albumName || '', id, extension);

    // Do not proxy the audio body through Vercel. The official CDN supports
    // CORS and Range requests, so both the Web Worker and browser download
    // manager can follow this short-lived redirect and receive bytes directly.
    response.statusCode = 307;
    for (const [name, value] of Object.entries({
      Location: sourceUrl,
      'Content-Disposition': `attachment; filename="${id}.${extension}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'X-Siren-Audio-Delivery': 'official-cdn-redirect',
      'Cache-Control': 'no-store',
      ...corsHeaders(request)
    })) response.setHeader(name, value);
    response.end();
  } catch (error) {
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    console.error('[SirenRecords] serverless audio URL resolution failed', error);
    sendJson(response, 502, { error: '音频下载服务暂时不可用，请稍后重试' }, request);
  }
}
