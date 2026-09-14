import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { rateBuckets } from '../cloudflare-worker/src/index.mjs';

const env = {
  ALLOWED_ORIGINS: 'https://mxwf0.github.io,http://127.0.0.1:4173',
  AUDIO_HOSTS: 'hycdn.cn',
  AUDIO_RATE_LIMIT: '8',
  CATALOG_RATE_LIMIT: '60',
  RATE_LIMIT_WINDOW_MS: '60000',
  UPSTREAM_TIMEOUT_MS: '1000'
};

function context() {
  return { waitUntil(promise) { void promise; } };
}

function cacheStub() {
  const entries = new Map();
  return {
    default: {
      async match(request) { return entries.get(request.url)?.clone(); },
      async put(request, response) { entries.set(request.url, response.clone()); }
    }
  };
}

function request(path, headers = {}) {
  return new Request(`https://api.example.test${path}`, { headers });
}

describe('Cloudflare Worker API', () => {
  beforeEach(() => {
    rateBuckets.clear();
    vi.stubGlobal('caches', cacheStub());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns health and security headers', async () => {
    const response = await worker.fetch(request('/api/health', { Origin: 'https://mxwf0.github.io' }), env, context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', platform: 'cloudflare-workers' });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://mxwf0.github.io');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('rejects an invalid CID before an upstream request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await worker.fetch(request('/api/audio?id=not valid'), env, context());
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an untrusted origin', async () => {
    const response = await worker.fetch(request('/api/catalog', { Origin: 'https://evil.example' }), env, context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: '当前网站没有权限使用此接口' });
  });

  it('answers an allowed CORS preflight without an upstream request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await worker.fetch(new Request('https://api.example.test/api/audio', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mxwf0.github.io', 'Access-Control-Request-Headers': 'Range' }
    }), env, context());
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://mxwf0.github.io');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projects and caches only the catalog fields used by the frontend', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/albums')) return new Response(JSON.stringify({ data: [{ cid: 'a1', name: 'Album', coverUrl: 'https://web.hycdn.cn/cover.jpg', secret: 'drop' }] }));
      return new Response(JSON.stringify({ data: { list: [{ cid: 's1', name: 'Song', albumCid: 'a1', artists: ['Artist'], duration: 12, sourceUrl: 'https://res01.hycdn.cn/signed.wav', secret: 'drop' }] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = await worker.fetch(request('/api/catalog'), env, context());
    const second = await worker.fetch(request('/api/catalog'), env, context());
    expect(first.status).toBe(200);
    expect((await first.json()).songs.data.list[0]).toEqual({ cid: 's1', name: 'Song', albumCid: 'a1', artist: 'Artist', duration: 12 });
    expect(second.headers.get('x-siren-cache')).toBe('HIT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty-body 307 for audio without fetching CDN bytes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {
      cid: 's1', name: 'Song', albumName: 'Album', sourceUrl: 'https://res01.hycdn.cn/fresh/song.flac'
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const response = await worker.fetch(request('/api/audio?id=s1', { Origin: 'https://mxwf0.github.io', Range: 'bytes=0-0' }), env, context());
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://res01.hycdn.cn/fresh/song.flac');
    expect(response.headers.get('content-disposition')).toContain('.flac');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns Retry-After when the audio rate limit is exceeded', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {
      cid: 's1', name: 'Song', sourceUrl: 'https://res01.hycdn.cn/fresh/song.wav'
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const limitedEnv = { ...env, AUDIO_RATE_LIMIT: '1' };
    const first = await worker.fetch(request('/api/audio?id=s1'), limitedEnv, context());
    const second = await worker.fetch(request('/api/audio?id=s1'), limitedEnv, context());
    expect(first.status).toBe(307);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches song details without exposing sourceUrl', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {
      cid: 's1', name: 'Song', albumName: 'Album', artist: 'Artist', sourceUrl: 'https://res01.hycdn.cn/signed.wav', internal: 'drop'
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const first = await worker.fetch(request('/api/song?id=s1'), env, context());
    const second = await worker.fetch(request('/api/song?id=s1'), env, context());
    const payload = await first.json();
    expect(payload.data).toEqual({ cid: 's1', name: 'Song', albumCid: '', albumName: 'Album', artist: 'Artist' });
    expect(payload.data.sourceUrl).toBeUndefined();
    expect(second.headers.get('x-siren-cache')).toBe('HIT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose upstream errors or signed URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream secret https://res01.hycdn.cn/signed.wav', { status: 503 })));
    const response = await worker.fetch(request('/api/audio?id=s1'), env, context());
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain('signed.wav');
    expect(body).toContain('官网服务暂时不可用');
  });
});
