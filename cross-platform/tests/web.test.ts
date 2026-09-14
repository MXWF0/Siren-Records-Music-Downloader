import { describe, expect, it, vi } from 'vitest';
import {
  browserDownloadNeedsUserGesture,
  canUseFileSystemStream,
  friendlyDownloadError,
  handOffBrowserManagedDownload,
  isCompleteDownloadSize,
  normalizeApiBase,
  resolveApiUrl,
  resolveDownloadProxy,
  resolveWebDownloadMode,
  rangeHeaderForOffset,
  responseFileName,
  resolveWorkerAssetUrl,
  shouldReplaceDownloadRecord,
  webDownloadConcurrency,
  webPlatform
} from '../src/platform/web';

describe('web download errors', () => {
  it('allows the queue to use the configured worker concurrency range', () => {
    expect(webDownloadConcurrency(true, false)).toBe(3);
    expect(webDownloadConcurrency(false, true)).toBe(3);
    expect(webDownloadConcurrency(false, false)).toBe(1);
    expect(webPlatform.maxConcurrentDownloads).toBe(1);
  });

  it('keeps the selected Web download strategy consistent across an album', () => {
    expect(resolveWebDownloadMode('stream', false, false)).toBe('stream');
    expect(resolveWebDownloadMode('browser', true, true, true)).toBe('browser');
    expect(resolveWebDownloadMode('auto', true, false)).toBe('stream');
    expect(resolveWebDownloadMode('auto', false, false)).toBe('browser');
  });

  it('requires a fresh click when the browser download manager owns the file', () => {
    expect(browserDownloadNeedsUserGesture(false, false, false, false)).toBe(true);
    expect(browserDownloadNeedsUserGesture(true, false, false, false)).toBe(false);
    expect(browserDownloadNeedsUserGesture(true, false, false, true)).toBe(true);
    expect(browserDownloadNeedsUserGesture(true, true, true, true)).toBe(false);
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

  it('explains a paused deployment instead of reporting a device network fault', () => {
    expect(friendlyDownloadError(new Error('HTTP 402: This deployment is temporarily paused'), false))
      .toContain('下载代理服务已暂停');
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

  it('uses the proxy filename and keeps the official response extension', () => {
    expect(responseFileName(
      "attachment; filename=42.wav; filename*=UTF-8''%5BAlbum%5D%20Track.flac",
      'audio/flac',
      '[Album] Track.wav'
    )).toBe('[Album] Track.flac');
    expect(responseFileName('', 'audio/mpeg', '[Album] Track.wav')).toBe('[Album] Track.mp3');
  });

  it('uses File System Access only with an active user gesture', () => {
    expect(canUseFileSystemStream(true, true)).toBe(true);
    expect(canUseFileSystemStream(true, false)).toBe(false);
    expect(canUseFileSystemStream(false, true)).toBe(false);
  });

  it('hands unsupported browsers a direct proxy response without building a Blob', () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', rel: '', referrerPolicy: '', style: {}, click, remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } });
    handOffBrowserManagedDownload('/api/audio?id=42', 'Track.wav');
    expect(anchor.href).toBe('/api/audio?id=42');
    expect(anchor.download).toBe('Track.wav');
    expect(click).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('starts a mobile browser handoff synchronously inside the click task', async () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', rel: '', referrerPolicy: '', style: {}, click, remove: vi.fn() };
    vi.stubGlobal('window', { __SIREN_API_BASE__: '' });
    vi.stubGlobal('location', { protocol: 'https:' });
    vi.stubGlobal('navigator', { userActivation: { isActive: true }, userAgent: 'Mobile Safari' });
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    vi.stubGlobal('indexedDB', undefined);

    const result = webPlatform.startDownload({
      id: 'mobile-track',
      title: 'Mobile Track',
      fileName: 'Mobile Track.wav',
      downloadDirectory: '',
      separateDirectory: false
    });
    expect(click).toHaveBeenCalledOnce();
    await expect(result).resolves.toEqual({ started: true });
    await Promise.resolve();
    vi.unstubAllGlobals();
  });

  it('creates a single Range header for worker recovery', () => {
    expect(rangeHeaderForOffset(4096)).toBe('bytes=4096-');
    expect(rangeHeaderForOffset(0)).toBeUndefined();
  });

  it('rejects a truncated stream when Content-Length is known', () => {
    expect(isCompleteDownloadSize(1024, 1024)).toBe(true);
    expect(isCompleteDownloadSize(900, 1024)).toBe(false);
    expect(isCompleteDownloadSize(900, null)).toBe(true);
  });

  it('does not downgrade a confirmed download when a retry fails or is handed off', () => {
    const completed = {
      cid: '42', name: 'Track', filename: 'Track.wav', size: 1024,
      downloadedAt: 1, status: 'completed' as const
    };
    expect(shouldReplaceDownloadRecord(completed, { ...completed, status: 'failed' })).toBe(false);
    expect(shouldReplaceDownloadRecord(completed, { ...completed, status: 'handed_off' })).toBe(false);
    expect(shouldReplaceDownloadRecord({ ...completed, status: 'failed' }, completed)).toBe(true);
  });

  it('keeps the repository base path when resolving a hashed Worker asset', () => {
    const generated = new URL(
      'https://mxwf0.github.io/Siren-Records-Music-Downloader/web-download.worker-abc123.js'
    );
    const resolved = resolveWorkerAssetUrl(
      generated,
      'https://mxwf0.github.io/Siren-Records-Music-Downloader/',
      ['https://mxwf0.github.io/Siren-Records-Music-Downloader/assets/index-def456.js']
    );
    expect(resolved.href).toBe(
      'https://mxwf0.github.io/Siren-Records-Music-Downloader/assets/web-download.worker-abc123.js'
    );
  });

  it('does not rewrite development Worker URLs that are not production assets', () => {
    const generated = new URL('http://localhost:1420/src/web-download.worker.ts');
    expect(resolveWorkerAssetUrl(generated, 'http://localhost:1420/', [])).toBe(generated);
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
