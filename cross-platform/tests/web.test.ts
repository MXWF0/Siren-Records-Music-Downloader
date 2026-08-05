import { describe, expect, it, vi } from 'vitest';
import { friendlyDownloadError, normalizeApiBase, resolveApiUrl, resolveDownloadProxy } from '../src/platform/web';

describe('web download errors', () => {
  it('explains expired CDN URLs in static preview mode', () => {
    const message = friendlyDownloadError(new Error('音频请求失败：HTTP 403'), true);
    expect(message).toContain('官网音频地址已过期');
    expect(message).toContain('npm run web');
  });

  it('does not expose a direct CDN navigation fallback', () => {
    const message = friendlyDownloadError(new TypeError('Failed to fetch'), true);
    expect(message).toContain('未连接官网代理');
    expect(message).toContain('/api');
  });

  it('points HTTP pages to the local proxy when it is missing', () => {
    const message = friendlyDownloadError(new Error('音频请求失败：HTTP 404'), false);
    expect(message).toContain('官网下载代理不可用');
    expect(message).toContain('/api/audio?id=:id');
  });

  it('normalizes a remote proxy origin for static deployments', () => {
    expect(normalizeApiBase(' https://proxy.example/// ')).toBe('https://proxy.example');
    expect(resolveApiUrl('/api/audio?id=42', 'https://proxy.example/')).toBe('https://proxy.example/api/audio?id=42');
  });

  it('detects the local proxy when a file page has no configured base', async () => {
    vi.stubGlobal('window', { __SIREN_API_BASE__: '' });
    vi.stubGlobal('location', { protocol: 'file:' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: url === 'http://127.0.0.1:4173/api/catalog',
      json: async () => ({ albums: {}, songs: {} })
    })));
    await expect(resolveDownloadProxy()).resolves.toBe('http://127.0.0.1:4173');
    vi.unstubAllGlobals();
  });
});
