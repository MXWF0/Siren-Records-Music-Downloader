import { corsHeaders, getCatalog, sendJson } from '../scripts/official-proxy.mjs';

export default async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    Object.entries(corsHeaders()).forEach(([name, value]) => response.setHeader(name, value));
    response.end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method Not Allowed' }, { Allow: 'GET, HEAD, OPTIONS' });
    return;
  }
  try {
    const payload = await getCatalog();
    response.statusCode = 200;
    for (const [name, value] of Object.entries({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      ...corsHeaders()
    })) response.setHeader(name, value);
    if (request.method === 'HEAD') response.end();
    else response.end(JSON.stringify(payload));
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知网络错误';
    sendJson(response, 502, { error: `无法获取官网目录：${reason}` });
  }
}
