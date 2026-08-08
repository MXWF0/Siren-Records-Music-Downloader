import bundledCatalog from '../catalog-cache.json';
import { defaultSettings, normalizeSettings, type AppSettings } from '../settings';
import type {
  DownloadEvents,
  DownloadRequest,
  PersistedQueueState,
  PlatformBridge
} from './types';

const settingsStorageKey = 'siren-records.settings.v1';
const queueStorageKey = 'siren-records.queue.v1';
const downloadedStorageKey = 'siren-records.downloaded.v1';
const browserDefaults: AppSettings = { ...defaultSettings, separateDirectory: false };
const listeners = new Set<DownloadEvents>();
const activeDownloads = new Map<string, AbortController>();
const bundledCatalogPayload = bundledCatalog as { albums: unknown; songs: unknown };

export function normalizeApiBase(value: unknown): string {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' || url.protocol === 'http:' ? normalized : '';
  } catch {
    return '';
  }
}

export function getConfiguredApiBase(): string {
  const runtimeBase = typeof window !== 'undefined' ? window.__SIREN_API_BASE__ : '';
  return normalizeApiBase(runtimeBase || import.meta.env?.VITE_API_BASE_URL);
}

export function resolveApiUrl(path: string, base = getConfiguredApiBase()): string {
  const normalizedBase = normalizeApiBase(base);
  return normalizedBase ? `${normalizedBase}${path.startsWith('/') ? path : `/${path}`}` : path;
}

const localProxyCandidates = ['http://127.0.0.1:4173', 'http://localhost:4173'];
let detectedProxyBase: string | null | undefined;
let detectedProxyPromise: Promise<string> | undefined;
let detectedProxyCheckedAt = 0;

function isCatalogPayload(value: unknown): value is { albums: unknown; songs: unknown } {
  return Boolean(value && typeof value === 'object' && 'albums' in value && 'songs' in value);
}

async function probeLocalProxy(base: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${base}/api/catalog`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    return isCatalogPayload(await response.json()) ? base : null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function resolveDownloadProxy(): Promise<string> {
  const configured = getConfiguredApiBase();
  if (configured) return configured;
  if (typeof location === 'undefined' || location.protocol !== 'file:') return '';
  if (detectedProxyBase) return detectedProxyBase;
  if (detectedProxyBase === null && Date.now() - detectedProxyCheckedAt < 5000) return '';
  detectedProxyPromise ??= Promise.all(localProxyCandidates.map(probeLocalProxy))
    .then((results) => {
      detectedProxyBase = results.find((value): value is string => Boolean(value)) || null;
      detectedProxyCheckedAt = Date.now();
      return detectedProxyBase || '';
    })
    .finally(() => { detectedProxyPromise = undefined; });
  return detectedProxyPromise;
}

function emit<K extends keyof DownloadEvents>(type: K, payload: Parameters<DownloadEvents[K]>[0]) {
  listeners.forEach((listener) => listener[type](payload as never));
}

function readStoredSettings() {
  const raw = localStorage.getItem(settingsStorageKey);
  return raw ? normalizeSettings(JSON.parse(raw)) : { ...browserDefaults };
}

async function readError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error) return payload.error;
  } catch {
    // A proxy or host may return a non-JSON error page.
  }
  return fallback;
}

const staticDownloadHint = '当前静态页面尚未配置下载服务，请联系维护者配置后端代理地址。';
const proxyDownloadHint = '下载服务暂时无法连接，请稍后重试；若持续失败，请联系维护者检查 /api/audio 接口。';
const proxyConfigurationHint = '当前站点没有可用的下载代理，请联系维护者配置 VITE_API_BASE_URL 或同源 /api 服务。';

export function friendlyDownloadError(error: unknown, staticFileMode: boolean) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/请求过于频繁|HTTP 429/i.test(message)) return message || '下载请求过于频繁，请稍后重试';
  if (/没有权限|未获.*授权|HTTP 403/i.test(message)) return '当前站点未获得下载服务授权，请联系维护者检查允许来源设置。';
  if (/没有可用的下载代理|HTTP 404|text\/html/i.test(message)) return staticFileMode ? staticDownloadHint : proxyConfigurationHint;
  if (/Failed to fetch|NetworkError|Load failed|CORS|fetch failed/i.test(message)) return staticFileMode ? staticDownloadHint : proxyDownloadHint;
  return message || (staticFileMode ? staticDownloadHint : '浏览器下载失败');
}

function launchBrowserManagedDownload(endpoint: string) {
  const anchor = document.createElement('a');
  anchor.href = endpoint;
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function streamToWritableFile(
  endpoint: string,
  request: DownloadRequest,
  controller: AbortController
) {
  const handle = await window.showSaveFilePicker!({
    suggestedName: request.fileName || `${request.id}.wav`,
    types: [{
      description: '官网原始音频',
      accept: {
        'audio/wav': ['.wav'],
        'audio/flac': ['.flac'],
        'audio/mpeg': ['.mp3'],
        'audio/mp4': ['.m4a'],
        'audio/ogg': ['.ogg'],
        'audio/aac': ['.aac']
      }
    }]
  });
  const writable = await handle.createWritable();
  try {
    const response = await fetch(endpoint, { signal: controller.signal, cache: 'no-store' });
    const responseType = (response.headers.get('content-type') || '').toLowerCase();
    if (responseType.includes('text/html')) throw new Error(proxyConfigurationHint);
    if (!response.ok) throw new Error(await readError(response, `下载服务返回 HTTP ${response.status}`));
    if (!response.body) throw new Error('浏览器没有返回可读取的音频流');

    const total = Number(response.headers.get('content-length')) || null;
    const reader = response.body.getReader();
    const startedAt = performance.now();
    let loaded = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      await writable.write(next.value);
      loaded += next.value.byteLength;
      const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      const rate = loaded / elapsedSeconds;
      emit('progress', {
        id: request.id,
        loaded,
        total,
        rate,
        etaSeconds: total && rate > 0 ? Math.ceil((total - loaded) / rate) : null
      });
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function downloadAudio(request: DownloadRequest, controller: AbortController) {
  let staticFileMode = false;
  try {
    const apiBase = await resolveDownloadProxy();
    staticFileMode = location.protocol === 'file:' && !apiBase;
    if (staticFileMode) throw new Error(staticDownloadHint);
    const endpoint = apiBase
      ? resolveApiUrl(`/api/audio?id=${encodeURIComponent(request.id)}`, apiBase)
      : `/api/audio?id=${encodeURIComponent(request.id)}`;

    const browserManaged = !window.showSaveFilePicker;
    if (!browserManaged) {
      await streamToWritableFile(endpoint, request, controller);
    } else {
      // Android Chrome and iOS Safari stream through the browser download
      // manager. The page cannot observe completion, but it also never holds
      // a complete Blob, ArrayBuffer or decoded AudioBuffer in memory.
      launchBrowserManagedDownload(endpoint);
    }
    emit('complete', { id: request.id, browserManaged });
  } catch (error) {
    const userCancelled = error instanceof DOMException && error.name === 'AbortError';
    if (controller.signal.aborted || userCancelled) emit('cancelled', { id: request.id });
    else emit('failed', { id: request.id, message: friendlyDownloadError(error, staticFileMode) });
  } finally {
    activeDownloads.delete(request.id);
  }
}

export const webPlatform: PlatformBridge = {
  kind: 'web',
  // Browser-managed downloads must be launched serially on Android/iOS or
  // their popup/download protection may reject later files.
  maxConcurrentDownloads: typeof window !== 'undefined' && window.showSaveFilePicker ? 3 : 1,

  async getSettings() {
    try { return readStoredSettings(); } catch { return { ...browserDefaults }; }
  },

  async saveSettings(settings) {
    localStorage.setItem(settingsStorageKey, JSON.stringify(normalizeSettings(settings)));
  },

  async selectDirectory() {
    throw new Error('网页端由浏览器管理下载位置，无法在应用内切换目录。');
  },

  async validateDownloadDirectory() {
    // Browser downloads are written by the browser download manager.
  },

  async loadOfficialCatalog() {
    const apiBase = await resolveDownloadProxy();
    if (location.protocol !== 'file:' || apiBase) {
      try {
        const response = await fetch(resolveApiUrl('/api/catalog', apiBase), { cache: 'no-store' });
        if (response.ok) {
          const payload = await response.json();
          if (isCatalogPayload(payload)) return payload;
          throw new Error('官网目录代理返回了无效数据');
        }
        console.warn('实时目录代理不可用，将使用内置目录快照：', await readError(response, `HTTP ${response.status}`));
      } catch (error) {
        console.warn('实时目录请求失败，将使用内置目录快照：', error);
      }
    }
    return bundledCatalogPayload;
  },

  async loadSongDetails(id) {
    const apiBase = await resolveDownloadProxy();
    const response = await fetch(resolveApiUrl(`/api/song?id=${encodeURIComponent(id)}`, apiBase), { cache: 'no-store' });
    if (!response.ok) throw new Error(await readError(response, `歌曲详情请求失败（HTTP ${response.status}）`));
    return (await response.json() as { data?: unknown }).data;
  },

  async loadDownloadedIds() {
    try {
      const value = JSON.parse(localStorage.getItem(downloadedStorageKey) || '[]');
      return Array.isArray(value) ? value.map(String) : [];
    } catch {
      return [];
    }
  },

  async loadQueueState() {
    try {
      return JSON.parse(localStorage.getItem(queueStorageKey) || 'null') as PersistedQueueState | null;
    } catch {
      return null;
    }
  },

  async saveQueueState(state) {
    localStorage.setItem(queueStorageKey, JSON.stringify(state));
  },

  async getPlatformInfo() {
    const apiBase = await resolveDownloadProxy();
    return {
      os: navigator.platform || 'Web',
      arch: '浏览器管理',
      appVersion: `v${__APP_VERSION__}`,
      runtime: location.protocol === 'file:'
        ? (apiBase ? 'Web 静态预览（远程代理）' : 'Web 静态预览（下载需代理）')
        : (apiBase ? 'Web 远程代理模式' : 'Web 同源代理模式')
    };
  },

  async recoverDownloads() {
    // Browser downloads have no application-owned temporary directory.
  },

  async startDownload(request) {
    if (activeDownloads.has(request.id)) throw new Error('该歌曲正在下载');
    const controller = new AbortController();
    activeDownloads.set(request.id, controller);
    void downloadAudio(request, controller);
    return { started: true };
  },

  async cancelDownload(id) {
    const controller = activeDownloads.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  },

  async listenDownloadEvents(events) {
    listeners.add(events);
    return () => listeners.delete(events);
  }
};
