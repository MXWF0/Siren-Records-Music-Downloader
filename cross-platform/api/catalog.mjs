import { corsHeaders, enforceRequestPolicy, getCatalog, sendJson } from '../scripts/official-proxy.mjs';

export default async function handler(request, response) {
  if (!enforceRequestPolicy(request, response, 'catalog', { count: request.method === 'GET' })) return;
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    Object.entries(corsHeaders(request)).forEach(([name, value]) => response.setHeader(name, value));
    response.end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: '仅支持 GET、HEAD 请求' }, request, { Allow: 'GET, HEAD, OPTIONS' });
    return;
  }
  try {
    const payload = await getCatalog();
    response.statusCode = 200;
    for (const [name, value] of Object.entries({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      ...corsHeaders(request)
    })) response.setHeader(name, value);
    if (request.method === 'HEAD') response.end();
    else response.end(JSON.stringify(payload));
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知网络错误';
    sendJson(response, 502, { error: `无法获取官网目录：${reason}` }, request);
  }
}
