import {
  corsHeaders,
  enforceRequestPolicy,
  fetchOfficialSong,
  sendJson,
  validSongId
} from '../scripts/official-proxy.mjs';

export default async function handler(request, response) {
  if (!await enforceRequestPolicy(request, response, 'catalog', { count: request.method === 'GET' })) return;
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    Object.entries(corsHeaders(request)).forEach(([name, value]) => response.setHeader(name, value));
    response.end();
    return;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: '仅支持 GET 请求' }, request, { Allow: 'GET, OPTIONS' });
    return;
  }
  const rawId = request.query?.id || new URL(request.url || '/', 'http://localhost').searchParams.get('id') || '';
  const id = Array.isArray(rawId) ? rawId[0] : String(rawId);
  if (!validSongId(id)) {
    sendJson(response, 400, { error: '歌曲编号无效' }, request);
    return;
  }
  try {
    sendJson(response, 200, { data: await fetchOfficialSong(id, { includeDuration: true }) }, request);
  } catch (error) {
    console.error('[SirenRecords] serverless song proxy failed', error);
    sendJson(response, 502, { error: '歌曲详情暂时不可用，请稍后重试' }, request);
  }
}
