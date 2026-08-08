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
const catalogStorageKey = 'siren-records.catalog.v1';
const downloadsDbName = 'siren-records.downloads.v1';
const downloadsStoreName = 'downloads';
const browserDefaults: AppSettings = { ...defaultSettings, separateDirectory: false };
const listeners = new Set<DownloadEvents>();
interface FileWritableLike {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
  seek?(position: number): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<FileWritableLike>;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileHandleLike>;
}

interface DownloadWorkerStart {
  type: 'start';
  requestId: string;
  endpoint: string;
  mode: 'stream' | 'blob';
  range?: string;
}

interface DownloadWorkerCancel {
  type: 'cancel';
  requestId: string;
}

interface DownloadWorkerResponse {
  type: 'response';
  requestId: string;
  status: number;
  contentType: string;
  contentLength: number | null;
  contentDisposition: string;
}

interface DownloadWorkerChunk {
  type: 'chunk';
  requestId: string;
  buffer: ArrayBuffer;
  loaded: number;
  total: number | null;
}

interface DownloadWorkerBlob {
  type: 'blob';
  requestId: string;
  blob: Blob;
  loaded: number;
  total: number | null;
}

interface DownloadWorkerProgress {
  type: 'progress';
  requestId: string;
  loaded: number;
  total: number | null;
}

interface DownloadWorkerTerminal {
  type: 'complete' | 'cancelled' | 'failed';
  requestId: string;
  message?: string;
  loaded?: number;
  total?: number | null;
}

type DownloadWorkerMessage = DownloadWorkerResponse | DownloadWorkerChunk | DownloadWorkerBlob | DownloadWorkerProgress | DownloadWorkerTerminal;

interface ActiveDownload {
  controller: AbortController;
  worker?: Worker;
  fileHandlePromise: Promise<FileHandleLike | null>;
}

const activeDownloads = new Map<string, ActiveDownload>();
let savePickerAttempted = false;
const bundledCatalogPayload = bundledCatalog as { albums: unknown; songs: unknown };

export interface WebDownloadRecord {
  cid: string;
  name: string;
  filename: string;
  size: number;
  downloadedAt: number;
  status: 'completed' | 'failed' | 'cancelled';
}

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

function readCachedCatalog(): { albums: unknown; songs: unknown } | null {
  try {
    const cached = JSON.parse(localStorage.getItem(catalogStorageKey) || 'null') as {
      updatedAt?: unknown;
      payload?: unknown;
    } | null;
    if (!cached || typeof cached.updatedAt !== 'number' || Date.now() - cached.updatedAt > 24 * 60 * 60_000) return null;
    return isCatalogPayload(cached.payload) ? cached.payload : null;
  } catch {
    return null;
  }
}

function cacheCatalog(payload: { albums: unknown; songs: unknown }) {
  try {
    localStorage.setItem(catalogStorageKey, JSON.stringify({ updatedAt: Date.now(), payload }));
  } catch {
    // Safari private mode and full storage must not prevent catalogue display.
  }
}

function fallbackDownloadRecords(): WebDownloadRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(downloadedStorageKey) || '[]');
    if (!Array.isArray(value)) return [];
    return value.map((cid): WebDownloadRecord => ({
      cid: String(cid),
      name: String(cid),
      filename: `${String(cid)}.wav`,
      size: 0,
      downloadedAt: 0,
      status: 'completed'
    }));
  } catch {
    return [];
  }
}

let downloadsDbPromise: Promise<IDBDatabase | null> | undefined;

function openDownloadsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  downloadsDbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(downloadsDbName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(downloadsStoreName)) {
          database.createObjectStore(downloadsStoreName, { keyPath: 'cid' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return downloadsDbPromise;
}

async function listDownloadRecords(): Promise<WebDownloadRecord[]> {
  const database = await openDownloadsDb();
  if (!database) return fallbackDownloadRecords();
  return new Promise((resolve) => {
    try {
      const request = database.transaction(downloadsStoreName, 'readonly')
        .objectStore(downloadsStoreName)
        .getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as WebDownloadRecord[] : []);
      request.onerror = () => resolve(fallbackDownloadRecords());
    } catch {
      resolve(fallbackDownloadRecords());
    }
  });
}

async function saveDownloadRecord(record: WebDownloadRecord): Promise<void> {
  const database = await openDownloadsDb();
  if (!database) {
    if (record.status === 'completed') {
      try {
        const ids = new Set(fallbackDownloadRecords().map((item) => item.cid));
        ids.add(record.cid);
        localStorage.setItem(downloadedStorageKey, JSON.stringify([...ids]));
      } catch {
        // Private browsing storage may be unavailable; the current session remains valid.
      }
    }
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const request = database.transaction(downloadsStoreName, 'readwrite')
        .objectStore(downloadsStoreName)
        .put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function migrateLegacyDownloadIds(records: WebDownloadRecord[]) {
  const known = new Set(records.map((record) => record.cid));
  const legacy = fallbackDownloadRecords();
  for (const record of legacy) {
    if (!known.has(record.cid)) {
      await saveDownloadRecord(record);
      records.push(record);
    }
  }
  return records;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function requestCatalog(endpoint: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(await readError(response, `HTTP ${response.status}`));
      const payload = await response.json();
      if (!isCatalogPayload(payload)) throw new Error('官网目录代理返回了无效数据');
      cacheCatalog(payload);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await delay(350);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw lastError;
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

function launchBrowserManagedDownload(blob: Blob, suggestedName: string) {
  const endpoint = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = endpoint;
  anchor.download = suggestedName;
  anchor.rel = 'noreferrer';
  anchor.referrerPolicy = 'no-referrer';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Keep the URL alive until the browser has queued the download, then release
  // it so large fallback blobs do not stay reachable indefinitely.
  globalThis.setTimeout(() => URL.revokeObjectURL(endpoint), 30_000);
}

function filenameFromContentDisposition(header: string, fallback: string) {
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = header.match(/filename="?([^";]+)"?/i)?.[1];
  let value = fallback;
  if (encoded) {
    try { value = decodeURIComponent(encoded); } catch { /* keep fallback */ }
  } else if (plain) {
    value = plain;
  }
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function pickerIsAvailable() {
  if (typeof window === 'undefined') return false;
  return typeof (window as SavePickerWindow).showSaveFilePicker === 'function';
}

function hasUserActivation() {
  if (typeof navigator === 'undefined' || !('userActivation' in navigator)) return true;
  return Boolean(navigator.userActivation?.isActive);
}

async function requestSaveFileHandle(request: DownloadRequest): Promise<FileHandleLike | null> {
  // A picker is a permission-gated operation. Only ask during the first user
  // gesture; queued songs afterwards use the browser download manager without
  // prompting for every item.
  if (savePickerAttempted || !pickerIsAvailable() || !hasUserActivation()) return null;
  savePickerAttempted = true;
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker({
      suggestedName: request.fileName || `${request.id}.wav`,
      types: [{
        description: '音频文件',
        accept: { 'audio/*': ['.wav', '.flac', '.mp3', '.m4a', '.ogg'] }
      }]
    });
  } catch (error) {
    // Explicit cancellation should be visible in the queue instead of silently
    // starting a second download through a different destination.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return null;
  }
}

function emitProgress(id: string, loaded: number, total: number | null, startedAt: number) {
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
  const rate = loaded / elapsedSeconds;
  const etaSeconds = total && rate > 0 ? Math.max(0, (total - loaded) / rate) : null;
  emit('progress', { id, loaded, total, rate, etaSeconds });
}

function cancelledError() {
  return new DOMException('下载已取消', 'AbortError');
}

async function runMainThreadFallback(
  request: DownloadRequest,
  endpoint: string,
  active: ActiveDownload,
  fileHandle: FileHandleLike | null
): Promise<number> {
  const response = await fetch(endpoint, {
    cache: 'no-store',
    credentials: 'omit',
    signal: active.controller.signal
  });
  if (!response.ok) throw new Error(await readError(response, `HTTP ${response.status}`));
  const contentLength = Number(response.headers.get('content-length'));
  const total = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
  const suggestedName = filenameFromContentDisposition(
    response.headers.get('content-disposition') || '',
    request.fileName || `${request.id}.wav`
  );
  const startedAt = performance.now();
  if (fileHandle) {
    const writer = await fileHandle.createWritable();
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('娴忚鍣ㄦ棤娉曡鍙栭煶棰戞祦');
      let loaded = 0;
      while (true) {
        if (active.controller.signal.aborted) throw cancelledError();
        const result = await reader.read();
        if (result.done) break;
        if (!result.value) continue;
        await writer.write(result.value.buffer.slice(result.value.byteOffset, result.value.byteOffset + result.value.byteLength));
        loaded += result.value.byteLength;
        emitProgress(request.id, loaded, total, startedAt);
      }
      await writer.close();
      return loaded;
    } catch (error) {
      if (writer.abort) await writer.abort(error).catch(() => undefined);
      throw error;
    }
  }
  const blob = await response.blob();
  if (active.controller.signal.aborted) throw cancelledError();
  emitProgress(request.id, blob.size, total ?? blob.size, startedAt);
  launchBrowserManagedDownload(blob, suggestedName);
  return blob.size;
}

async function runWorkerDownload(
  request: DownloadRequest,
  endpoint: string,
  active: ActiveDownload,
  fileHandle: FileHandleLike | null
): Promise<number> {
  if (active.controller.signal.aborted) throw cancelledError();
  let worker: Worker;
  try {
    worker = new Worker(new URL('./web-download.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // Safari versions without module workers still get a functional download.
    return runMainThreadFallback(request, endpoint, active, fileHandle);
  }
  let writer: FileWritableLike | null = null;
  try {
    writer = fileHandle ? await fileHandle.createWritable() : null;
  } catch (error) {
    worker.terminate();
    throw error;
  }
  if (active.controller.signal.aborted) {
    worker.terminate();
    if (writer?.abort) await writer.abort(cancelledError()).catch(() => undefined);
    throw cancelledError();
  }
  active.worker = worker;
  const requestId = `${request.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startedAt = performance.now();
  const mode = fileHandle ? 'stream' : 'blob';

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let writeChain = Promise.resolve();
    let lastLoaded = 0;
    let lastTotal: number | null = null;
    let resumeOffset = 0;
    let resumeTotal: number | null = null;
    let resumeAttempted = false;
    let fallbackBlob: Blob | undefined;
    let suggestedName = request.fileName || `${request.id}.wav`;

    const cleanup = () => {
      active.controller.signal.removeEventListener('abort', cancelWorker);
      worker.terminate();
      if (active.worker === worker) active.worker = undefined;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (writer?.abort) void writer.abort(error).catch(() => undefined);
      reject(error instanceof Error ? error : new Error(String(error || '下载失败')));
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      void writeChain.then(async () => {
        if (writer) await writer.close();
        if (!fileHandle && fallbackBlob) launchBrowserManagedDownload(fallbackBlob, suggestedName);
        cleanup();
        resolve(lastLoaded || fallbackBlob?.size || 0);
      }).catch((error) => {
        cleanup();
        if (writer?.abort) void writer.abort(error).catch(() => undefined);
        reject(error instanceof Error ? error : new Error(String(error || '下载失败')));
      });
    };
    const cancelWorker = () => {
      worker.postMessage({ type: 'cancel', requestId } satisfies DownloadWorkerCancel);
    };
    active.controller.signal.addEventListener('abort', cancelWorker, { once: true });

    worker.addEventListener('message', (event: MessageEvent<DownloadWorkerMessage>) => {
      const message = event.data;
      if (message.requestId !== requestId || settled) return;
      if (message.type === 'response') {
        suggestedName = filenameFromContentDisposition(message.contentDisposition, suggestedName);
        if (resumeOffset > 0 && message.status !== 206) {
          fail(new Error('服务器不支持断点续传，请重新下载'));
          return;
        }
        lastTotal = resumeOffset > 0
          ? (resumeTotal ?? (message.contentLength === null ? null : resumeOffset + message.contentLength))
          : message.contentLength;
        return;
      }
      if (message.type === 'chunk') {
        lastLoaded = resumeOffset + message.loaded;
        lastTotal = resumeOffset > 0
          ? (resumeTotal ?? (message.total === null ? null : resumeOffset + message.total))
          : message.total;
        if (!writer) return fail(new Error('浏览器不支持流式文件写入'));
        writeChain = writeChain
          .then(() => writer.write(message.buffer))
          .then(() => emitProgress(request.id, lastLoaded, lastTotal, startedAt))
          .catch((error) => { fail(error); });
        return;
      }
      if (message.type === 'progress') {
        lastLoaded = resumeOffset + message.loaded;
        lastTotal = resumeOffset > 0
          ? (resumeTotal ?? (message.total === null ? null : resumeOffset + message.total))
          : message.total;
        emitProgress(request.id, lastLoaded, lastTotal, startedAt);
        return;
      }
      if (message.type === 'blob') {
        fallbackBlob = message.blob;
        lastLoaded = message.loaded;
        lastTotal = message.total;
        emitProgress(request.id, lastLoaded, lastTotal, startedAt);
        return;
      }
      if (message.type === 'cancelled') return fail(cancelledError());
      if (message.type === 'failed') {
        const currentLoaded = resumeOffset + (message.loaded || 0);
        if (fileHandle && writer?.seek && !resumeAttempted && currentLoaded > 0 && !active.controller.signal.aborted) {
          resumeAttempted = true;
          resumeOffset = currentLoaded;
          resumeTotal = lastTotal ?? message.total ?? null;
          writeChain = writeChain
            .then(() => writer.seek!(resumeOffset))
            .then(() => {
              if (!settled) worker.postMessage({
                type: 'start', requestId, endpoint, mode,
                range: `bytes=${resumeOffset}-`
              } satisfies DownloadWorkerStart);
            })
            .catch((error) => { fail(error); });
          return;
        }
        return fail(new Error(message.message || '下载失败'));
      }
      if (message.type === 'complete') return finish();
    });
    worker.addEventListener('error', (event) => fail(new Error(event.message || '下载线程异常')));
    worker.postMessage({ type: 'start', requestId, endpoint, mode } satisfies DownloadWorkerStart);
  });
}

async function downloadAudio(request: DownloadRequest, active: ActiveDownload) {
  let staticFileMode = false;
  try {
    const fileHandle = await active.fileHandlePromise;
    if (active.controller.signal.aborted) throw cancelledError();
    const apiBase = await resolveDownloadProxy();
    staticFileMode = typeof location !== 'undefined' && location.protocol === 'file:' && !apiBase;
    if (staticFileMode) throw new Error(staticDownloadHint);
    const endpoint = apiBase
      ? resolveApiUrl(`/api/audio?id=${encodeURIComponent(request.id)}`, apiBase)
      : `/api/audio?id=${encodeURIComponent(request.id)}`;
    const size = await runWorkerDownload(request, endpoint, active, fileHandle);
    await saveDownloadRecord({
      cid: request.id,
      name: request.title || request.id,
      filename: request.fileName || `${request.id}.wav`,
      size,
      downloadedAt: Date.now(),
      status: 'completed'
    });
    emit('complete', { id: request.id, browserManaged: !fileHandle, size });
  } catch (error) {
    const userCancelled = error instanceof DOMException && error.name === 'AbortError';
    if (active.controller.signal.aborted || userCancelled) {
      await saveDownloadRecord({
        cid: request.id,
        name: request.title || request.id,
        filename: request.fileName || `${request.id}.wav`,
        size: 0,
        downloadedAt: Date.now(),
        status: 'cancelled'
      });
      emit('cancelled', { id: request.id });
    } else {
      await saveDownloadRecord({
        cid: request.id,
        name: request.title || request.id,
        filename: request.fileName || `${request.id}.wav`,
        size: 0,
        downloadedAt: Date.now(),
        status: 'failed'
      });
      emit('failed', { id: request.id, message: friendlyDownloadError(error, staticFileMode) });
    }
  } finally {
    activeDownloads.delete(request.id);
  }
}

export const webPlatform: PlatformBridge = {
  kind: 'web',
  // The worker keeps network work off the Vue thread. The queue still caps the
  // default at two and lets the user choose one to three concurrent tasks.
  maxConcurrentDownloads: 3,

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
    const fallback = readCachedCatalog() || bundledCatalogPayload;
    if (location.protocol !== 'file:' || apiBase) {
      const remote = requestCatalog(resolveApiUrl('/api/catalog', apiBase)).catch((error) => {
        console.warn('实时目录请求失败，将使用本地官方目录快照：', error);
        return fallback;
      });
      // Mobile browsers should display the complete bundled catalogue quickly
      // while a cold serverless request continues and refreshes the next load.
      return Promise.race([remote, delay(2_500).then(() => fallback)]);
    }
    return fallback;
  },

  async loadSongDetails(id) {
    const apiBase = await resolveDownloadProxy();
    const response = await fetch(resolveApiUrl(`/api/song?id=${encodeURIComponent(id)}`, apiBase), { cache: 'no-store' });
    if (!response.ok) throw new Error(await readError(response, `歌曲详情请求失败（HTTP ${response.status}）`));
    return (await response.json() as { data?: unknown }).data;
  },

  async loadDownloadedIds() {
    const records = await migrateLegacyDownloadIds(await listDownloadRecords());
    return [...new Set(records.filter((record) => record.status === 'completed').map((record) => String(record.cid)))];
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
    const active: ActiveDownload = {
      controller,
      // Invoke this before the first await in the queue call so a real click's
      // user activation can reach showSaveFilePicker when available.
      fileHandlePromise: requestSaveFileHandle(request)
    };
    activeDownloads.set(request.id, active);
    void downloadAudio(request, active);
    return { started: true };
  },

  async cancelDownload(id) {
    const active = activeDownloads.get(id);
    if (!active) return false;
    active.controller.abort();
    return true;
  },

  async listenDownloadEvents(events) {
    listeners.add(events);
    return () => listeners.delete(events);
  }
};
