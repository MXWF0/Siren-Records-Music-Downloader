import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import audioHandler from '../api/audio/[id].mjs';
import { resetRateLimitsForTests } from '../scripts/official-proxy.mjs';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.body = undefined;
    this.destroyed = false;
    this.headersSent = false;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), String(value));
  }

  end(body) {
    this.body = body;
    this.headersSent = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

describe('serverless audio redirect', () => {
  beforeEach(() => resetRateLimitsForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('resolves metadata once and redirects without fetching the audio body', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toBe('https://monster-siren.hypergryph.com/api/song/779442');
      return new Response(JSON.stringify({ data: {
        cid: '779442',
        name: 'Test Track',
        sourceUrl: 'https://res01.hycdn.cn/fresh/audio.wav'
      } }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = new MockResponse();
    await audioHandler({
      method: 'GET',
      url: '/api/audio?id=779442',
      query: { id: '779442' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' }
    }, response);

    expect(response.statusCode).toBe(307);
    expect(response.headers.get('location')).toBe('https://res01.hycdn.cn/fresh/audio.wav');
    expect(response.headers.get('x-siren-audio-delivery')).toBe('official-cdn-redirect');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
