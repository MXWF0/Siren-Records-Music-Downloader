import { defaultSettings, normalizeSettings, type AppSettings } from '../settings';
import type { DownloadEvents, DownloadRequest, PlatformBridge } from './types';
import bundledCatalog from '../catalog-cache.json';

const storageKey = 'siren-records.settings.v1';
const browserDefaults: AppSettings = { ...defaultSettings, separateDirectory: false };
const listeners = new Set<DownloadEvents>();
const activeDownloads = new Map<string, AbortController>();
const bundledCatalogPayload = bundledCatalog as { albums: unknown; songs: unknown; details?: Record<string, unknown> };

/**
 * An index.html file has no server-side privileges and cannot refresh the
 * signed CDN URL by itself.  A deployable proxy can be configured at build
 * time, which keeps the frontend static while moving signature refresh to a
 * same-origin or CORS-enabled API.
 */
export function normalizeApiBase(value: unknown): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
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
    const payload = await response.json();
    return isCatalogPayload(payload) ? base : null;
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
  if (detectedProxyBase && detectedProxyBase.length > 0) return detectedProxyBase;
  if (detectedProxyBase === null && Date.now() - detectedProxyCheckedAt < 5000) return '';
  if (!detectedProxyPromise) {
    detectedProxyPromise = Promise.all(localProxyCandidates.map(probeLocalProxy))
      .then((results) => {
        detectedProxyBase = results.find((value): value is string => Boolean(value)) || null;
        detectedProxyCheckedAt = Date.now();
        return detectedProxyBase || '';
      })
      .finally(() => { detectedProxyPromise = undefined; });
  }
  return detectedProxyPromise;
}

function emit<K extends keyof DownloadEvents>(type: K, payload: Parameters<DownloadEvents[K]>[0]) {
  listeners.forEach((listener) => listener[type](payload as never));
}

function readStoredSettings() {
  const raw = localStorage.getItem(storageKey);
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

function downloadFileName(response: Response, fallback: string) {
  const header = response.headers.get('content-disposition') || '';
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return fallback; }
  }
  return fallback;
}

function encodeWav(audio: AudioBuffer): ArrayBuffer {
  const channels = audio.numberOfChannels;
  const frames = audio.length;
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + frames * channels * bytesPerSample);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + frames * channels * bytesPerSample, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, frames * channels * bytesPerSample, true);
  const channelData = Array.from({ length: channels }, (_, channel) => audio.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

async function ensureWav(blob: Blob): Promise<Blob> {
  if ((blob.type || '').toLowerCase().includes('wav')) return blob;
  const contextConstructor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const audioContext = contextConstructor ? new contextConstructor() : null;
  if (!audioContext) throw new Error('当前浏览器无法将官网音频转换为 WAV');
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return new Blob([encodeWav(decoded)], { type: 'audio/wav' });
  } finally {
    await audioContext.close();
  }
}

const staticDownloadHint = '当前页面未连接官网代理，不能刷新过期的音频签名。请从项目根目录部署并保留 /api 文件夹，或运行 npm run web 后访问 http://127.0.0.1:4173。';
const proxyDownloadHint = '官网下载代理不可用，请确认已从 cross-platform 根目录部署，并检查 /api/audio?id=:id 接口。';

export function friendlyDownloadError(error: unknown, staticFileMode: boolean) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (staticFileMode) {
    if (/HTTP (401|403|404)/i.test(message)) return `官网音频地址已过期或被 CDN 拒绝。${staticDownloadHint}`;
    if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(message)) return staticDownloadHint;
  } else if (/HTTP 404|Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return proxyDownloadHint;
  }
  return message || (staticFileMode ? staticDownloadHint : '浏览器下载失败');
}

async function downloadAudio(request: DownloadRequest, controller: AbortController) {
  let apiBase = '';
  let staticFileMode = false;
  try {
    apiBase = await resolveDownloadProxy();
    staticFileMode = location.protocol === 'file:' && !apiBase;
    let response: Response | undefined;
    let proxyFailure: Error | undefined;

    if (!staticFileMode) {
      const endpoint = apiBase
        ? resolveApiUrl(`/api/audio?id=${encodeURIComponent(request.id)}`, apiBase)
        : `/api/audio?id=${encodeURIComponent(request.id)}`;
      try {
        const candidate = await fetch(endpoint, { signal: controller.signal });
        const candidateType = (candidate.headers.get('content-type') || '').toLowerCase();
        if (candidate.ok && !candidateType.includes('text/html')) response = candidate;
        else {
          const detail = await readError(candidate, `音频代理请求失败：HTTP ${candidate.status}`);
          proxyFailure = new Error(candidate.status === 404 || candidateType.includes('text/html') ? proxyDownloadHint : detail);
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        proxyFailure = new Error(friendlyDownloadError(error, false));
      }
    }

    // GitHub Pages and other static hosts cannot refresh the official API in
    // the browser, but a scheduled build can embed a fresh CORS-enabled CDN URL.
    if (!response && request.sourceUrl) {
      const candidate = await fetch(request.sourceUrl, { signal: controller.signal, cache: 'no-store' });
      const candidateType = (candidate.headers.get('content-type') || '').toLowerCase();
      if (!candidate.ok || candidateType.includes('text/html')) {
        throw new Error(`静态站点中的音频签名已过期（HTTP ${candidate.status}），请稍后刷新网页重试。`);
      }
      response = candidate;
    }

    if (!response) throw proxyFailure || new Error(staticDownloadHint);
    if (!response.body) throw new Error('浏览器没有返回可读取的音频流');

    const total = Number(response.headers.get('content-length')) || null;
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    const startedAt = performance.now();
    let loaded = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
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

    const sourceBlob = new Blob(chunks, { type: response.headers.get('content-type') || 'audio/wav' });
    const blob = await ensureWav(sourceBlob);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFileName(response, request.fileName || `${request.id}.wav`);
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    emit('complete', { id: request.id });
  } catch (error) {
    if (controller.signal.aborted) emit('cancelled', { id: request.id });
    else emit('failed', { id: request.id, message: friendlyDownloadError(error, staticFileMode) });
  } finally {
    activeDownloads.delete(request.id);
  }
}

export const webPlatform: PlatformBridge = {
  kind: 'web',

  async getSettings() {
    try {
      return readStoredSettings();
    } catch {
      return { ...browserDefaults };
    }
  },

  async saveSettings(settings: AppSettings) {
    localStorage.setItem(storageKey, JSON.stringify(normalizeSettings(settings)));
  },

  async selectDirectory() {
    if (!window.showDirectoryPicker) {
      throw new Error('当前浏览器不支持目录选择；浏览器版会交由浏览器下载设置保存文件。');
    }
    const directory = await window.showDirectoryPicker();
    return `浏览器目录：${directory.name}`;
  },

  async validateDownloadDirectory() {
    // The browser owns write permission through its download manager.
  },

  async loadOfficialCatalog() {
    const apiBase = await resolveDownloadProxy();
    if (location.protocol !== 'file:' || apiBase) {
      try {
        const response = await fetch(resolveApiUrl('/api/catalog', apiBase), { cache: 'no-store' });
        if (response.ok) {
          const payload = await response.json() as { albums?: unknown; songs?: unknown };
          if (payload && typeof payload === 'object' && 'albums' in payload && 'songs' in payload) {
            return payload as { albums: unknown; songs: unknown };
          }
          throw new Error('官网目录代理返回了无效数据');
        }
        console.warn('官网实时目录代理不可用，将使用内置官方快照：', await readError(response, `HTTP ${response.status}`));
      } catch (error) {
        console.warn('官网实时目录请求失败，将使用内置官方快照：', error);
      }
    }
    return bundledCatalogPayload;
  },

  async getPlatformInfo() {
    const apiBase = await resolveDownloadProxy();
    return {
      os: navigator.platform || 'Web',
      arch: '浏览器管理',
      appVersion: 'v1.1',
      runtime: location.protocol === 'file:'
        ? (apiBase ? 'Web 静态预览（远程代理）' : 'Web 静态预览（下载需代理）')
        : (apiBase ? 'Web 远程代理模式' : 'Web 同源代理模式')
    };
  },

  async recoverDownloads() {
    // Browser downloads are managed by the browser and have no app temp directory.
  },

  async startDownload(request: DownloadRequest) {
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

  async listenDownloadEvents(events: DownloadEvents) {
    listeners.add(events);
    return () => listeners.delete(events);
  }
};
