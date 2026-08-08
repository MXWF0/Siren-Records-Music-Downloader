import { describe, expect, it, vi } from 'vitest';
import { friendlyDownloadError, normalizeApiBase, resolveApiUrl, resolveDownloadProxy, webPlatform } from '../src/platform/web';

describe('web download errors', () => {
  it('allows the queue to use the configured worker concurrency range', () => {
    expect(webPlatform.maxConcurrentDownloads).toBe(3);
  });

  it('explains rejected origins without exposing backend details', () => {
    const message = friendlyDownloadError(new Error('当前网站没有权限使用此下载接口'), false);
    expect(message).toContain('未获得下载服务授权');
    expect(message).toContain('允许来源');
  });

  it('keeps the upstream HTTP status visible for an expired audio signature', () => {
    expect(friendlyDownloadError(new Error('HTTP 403：下载服务暂时不可用'), false))
      .toContain('HTTP 403：音频地址失效');
  });

  it('does not mislabel an origin policy rejection as an expired audio URL', () => {
    expect(friendlyDownloadError(new Error('HTTP 403：当前网站没有权限使用此下载接口'), false))
      .toContain('未获得下载服务授权');
  });

  it('explains browser file-write permission failures', () => {
    const error = new Error('The request is not allowed');
    error.name = 'NotAllowedError';
    expect(friendlyDownloadError(error, false)).toContain('NotAllowedError');
  });

  it('explains how a local static preview gets a download service', () => {
    const message = friendlyDownloadError(new TypeError('Failed to fetch'), true);
    expect(message).toContain('尚未配置下载服务');
    expect(message).toContain('维护者');
  });

  it('points static hosts to their proxy configuration when /api is missing', () => {
    const message = friendlyDownloadError(new Error('下载服务返回 HTTP 404'), false);
    expect(message).toContain('没有可用的下载代理');
    expect(message).toContain('VITE_API_BASE_URL');
  });

  it('normalizes a remote proxy origin for static deployments', () => {
    expect(normalizeApiBase(' https://proxy.example/// ')).toBe('https://proxy.example');
    expect(resolveApiUrl('/api/audio?id=42', 'https://proxy.example/')).toBe('https://proxy.example/api/audio?id=42');
    expect(normalizeApiBase('javascript:alert(1)')).toBe('');
    expect(normalizeApiBase('not a URL')).toBe('');
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
