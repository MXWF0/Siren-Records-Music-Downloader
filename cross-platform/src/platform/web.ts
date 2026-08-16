import bundledCatalog from '../catalog-cache.json';
import { defaultSettings, normalizeSettings, type AppSettings } from '../settings';
import type {
  DownloadEvents,
  DownloadRequest,
  PersistedQueueState,
  PlatformBridge
} from './types';

// `?worker&url` asks Vite to bundle the worker as JavaScript and expose its
// hashed asset URL. A plain `new URL('./worker.ts', import.meta.url)` is
// transformed into a raw `.ts` asset when the main entry is an IIFE, which
// browsers cannot execute as a module Worker.
const bundledWorkerUrl = (import.meta.glob('./web-download.worker.ts', {
  eager: true,
  import: 'default',
  query: '?worker&url'
}) as Record<string, string>)['./web-download.worker.ts'];

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

interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandleLike>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (options?: { mode?: 'readwrite' }) => Promise<DirectoryHandleLike>;
}

interface DownloadWorkerStart {
  type: 'start';
  requestId: string;
  endpoint: string;
  range?: string;
}

interface DownloadWorkerCancel {
  type: 'cancel';
  requestId: string;
}

interface DownloadWorkerChunkAck {
  type: 'chunk-ack';
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

interface DownloadWorkerReady {
  type: 'ready';
}

interface DownloadWorkerChunk {
  type: 'chunk';
  requestId: string;
  buffer: ArrayBuffer;
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
  errorName?: string;
  errorStack?: string;
  loaded?: number;
  total?: number | null;
  retryAfterSeconds?: number;
}

type DownloadWorkerMessage = DownloadWorkerReady | DownloadWorkerResponse | DownloadWorkerChunk | DownloadWorkerProgress | DownloadWorkerTerminal;

interface ActiveDownload {
  controller: AbortController;
  worker?: Worker;
  fileHandlePromise: Promise<FileHandleLike | null>;
}

const activeDownloads = new Map<string, ActiveDownload>();
let savePickerAttempted = false;
let downloadDirectoryHandle: DirectoryHandleLike | null = null;
let directorySelectionPromise: Promise<DirectoryHandleLike | null> | null = null;
const bundledCatalogPayload = bundledCatalog as { albums: unknown; songs: unknown };

export interface WebDownloadRecord {
  cid: string;
  name: string;
  filename: string;
  size: number;
  downloadedAt: number;
  status: 'completed' | 'handed_off' | 'failed' | 'cancelled';
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
let recentProxyFailure: { message: string; checkedAt: number } | null = null;

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
      const transaction = database.transaction(downloadsStoreName, 'readwrite');
      const store = transaction.objectStore(downloadsStoreName);
      const request = store.get(record.cid);
      request.onsuccess = () => {
        const existing = request.result as WebDownloadRecord | undefined;
        // A failed retry or browser handoff must not erase an earlier file
        // whose write was already confirmed by the application.
        if (shouldReplaceDownloadRecord(existing, record)) store.put(record);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function shouldReplaceDownloadRecord(
  existing: WebDownloadRecord | undefined,
  incoming: WebDownloadRecord
) {
  return incoming.status === 'completed' || existing?.status !== 'completed';
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
      recentProxyFailure = null;
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await delay(350);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  const normalized = normalizeDownloadError(lastError);
  recentProxyFailure = { message: normalized.message, checkedAt: Date.now() };
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

function normalizeDownloadError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown };
    const normalized = new Error(typeof value.message === 'string' ? value.message : String(error));
    if (typeof value.name === 'string' && value.name) normalized.name = value.name;
    if (typeof value.stack === 'string' && value.stack) normalized.stack = value.stack;
    return normalized;
  }
  return new Error(String(error || '下载失败'));
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
const proxyConfigurationHint = '当前站点没有可用的下载代理，请联系维护者配置 VITE_API_BASE_URL 或同源 /api 服务。';

export function friendlyDownloadError(error: unknown, staticFileMode: boolean) {
  const normalized = normalizeDownloadError(error);
  const message = normalized.message;
  if (/没有权限|未获.*授权/i.test(message)) return '当前站点未获得下载服务授权，请联系维护者检查允许来源设置。';
  if (/HTTP\s*403/i.test(message)) return 'HTTP 403：音频地址失效，代理正在刷新官方签名，请稍后重试。';
  if (/HTTP\s*401/i.test(message)) return 'HTTP 401：下载服务未授权，请稍后重试或联系维护者。';
  if (/HTTP\s*402|deployment.*paused|temporarily paused|代理服务已暂停/i.test(message)) {
    return '下载代理服务已暂停（HTTP 402），当前无法连接官网音频，请联系维护者恢复代理部署。';
  }
  if (/HTTP\s*404/i.test(message)) return staticFileMode ? staticDownloadHint : `HTTP 404：${proxyConfigurationHint}`;
  if (/NotAllowedError/i.test(normalized.name) || /NotAllowedError|拒绝文件写入权限|用户激活/i.test(message)) {
    return 'NotAllowedError：浏览器拒绝文件写入权限，请重新点击下载并允许保存。';
  }
  if (/QuotaExceededError/i.test(normalized.name) || /QuotaExceededError|磁盘空间不足|配额/i.test(message)) {
    return 'QuotaExceededError：磁盘空间不足或浏览器存储配额已用尽。';
  }
  if (/TypeError/i.test(normalized.name) && /流|stream|readable/i.test(message)) {
    return `TypeError：流处理错误（${message}）`;
  }
  if (/Worker|worker|下载线程/i.test(message)) return `下载线程异常：${message}`;
  if (/请求过于频繁|HTTP 429/i.test(message)) return message || '下载请求过于频繁，请稍后重试';
  if (/没有可用的下载代理|text\/html/i.test(message)) return staticFileMode ? staticDownloadHint : proxyConfigurationHint;
  if (/Failed to fetch|NetworkError|Load failed|CORS|fetch failed/i.test(message)) {
    return staticFileMode ? staticDownloadHint : `NetworkError：网络请求失败（${message}）`;
  }
  return message || (staticFileMode ? staticDownloadHint : '浏览器下载失败');
}

export function handOffBrowserManagedDownload(endpoint: string, suggestedName: string) {
  const anchor = document.createElement('a');
  anchor.href = endpoint;
  anchor.download = suggestedName;
  anchor.rel = 'noreferrer';
  anchor.referrerPolicy = 'no-referrer';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function pickerIsAvailable() {
  if (typeof window === 'undefined') return false;
  return typeof (window as SavePickerWindow).showSaveFilePicker === 'function';
}

function hasUserActivation() {
  if (typeof navigator === 'undefined' || !('userActivation' in navigator)) return true;
  return Boolean(navigator.userActivation?.isActive);
}

function directoryPickerIsAvailable() {
  if (typeof window === 'undefined') return false;
  return typeof (window as SavePickerWindow).showDirectoryPicker === 'function';
}

export function webDownloadConcurrency(savePicker: boolean, directoryPicker: boolean) {
  return savePicker || directoryPicker ? 3 : 1;
}

export function browserDownloadNeedsUserGesture(
  savePicker: boolean,
  directoryPicker: boolean,
  hasDirectoryHandle: boolean,
  pickerAttempted: boolean
) {
  return !hasDirectoryHandle && ((!savePicker && !directoryPicker) || pickerAttempted);
}

export function canUseFileSystemStream(
  pickerAvailable = pickerIsAvailable(),
  userActivated = hasUserActivation()
) {
  return pickerAvailable && userActivated;
}

export function rangeHeaderForOffset(offset: number) {
  return Number.isSafeInteger(offset) && offset > 0 ? `bytes=${offset}-` : undefined;
}

async function directoryFileHandle(request: DownloadRequest): Promise<FileHandleLike | null> {
  if (!downloadDirectoryHandle) return null;
  let directory = downloadDirectoryHandle;
  if (request.separateDirectory) {
    const album = safePathPart((request.fileName || '').match(/^\[([^\]]+)\]/)?.[1], '塞壬唱片');
    directory = await directory.getDirectoryHandle(album, { create: true });
  }
  // Delay file creation until the worker has received Content-Disposition.
  // This keeps the directory permission while allowing the proxy to replace
  // the provisional `.wav` extension with the official audio format.
  return {
    async createWritable() {
      const file = await directory.getFileHandle(
        safePathPart(request.fileName, `${request.id}.audio`),
        { create: true }
      );
      return file.createWritable();
    }
  };
}

function safePathPart(value: string | undefined, fallback: string) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || fallback;
}

export function responseFileName(contentDisposition: string, contentType: string, fallback: string) {
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = contentDisposition.match(/filename="?([^";]+)"?/i)?.[1];
  let headerName = plain || '';
  if (encoded) {
    try { headerName = decodeURIComponent(encoded); } catch { /* keep ASCII fallback */ }
  }
  const extension = contentType.toLowerCase().includes('flac') ? 'flac'
    : contentType.toLowerCase().includes('mpeg') ? 'mp3'
      : contentType.toLowerCase().includes('ogg') ? 'ogg'
        : contentType.toLowerCase().includes('mp4') ? 'm4a'
          : contentType.toLowerCase().includes('wav') ? 'wav' : '';
  const selected = safePathPart(headerName, safePathPart(fallback, 'audio'));
  if (!extension) return selected;
  return `${selected.replace(/\.[a-z0-9]{2,5}$/i, '')}.${extension}`;
}

async function requestSaveFileHandle(request: DownloadRequest): Promise<FileHandleLike | null> {
  if (downloadDirectoryHandle) {
    try {
      const permission = await downloadDirectoryHandle.queryPermission?.({ mode: 'readwrite' });
      if (permission === 'granted' || !downloadDirectoryHandle.queryPermission) {
        return await directoryFileHandle(request);
      }
      downloadDirectoryHandle = null;
    } catch {
      downloadDirectoryHandle = null;
    }
  }
  if (directorySelectionPromise) {
    downloadDirectoryHandle = await directorySelectionPromise;
    return directoryFileHandle(request);
  }
  // Choosing a directory once gives Chrome and Edge a stable batch-download
  // experience and preserves stream-to-disk writes for every queued track.
  if (directoryPickerIsAvailable() && hasUserActivation()) {
    savePickerAttempted = true;
    try {
      const picker = (window as SavePickerWindow).showDirectoryPicker;
      directorySelectionPromise = picker?.({ mode: 'readwrite' }) || Promise.resolve(null);
      downloadDirectoryHandle = await directorySelectionPromise;
      return await directoryFileHandle(request);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        savePickerAttempted = false;
        throw error;
      }
      downloadDirectoryHandle = null;
    } finally {
      directorySelectionPromise = null;
    }
  }
  // A picker is a permission-gated operation. Only ask during the first user
  // gesture; queued songs afterwards use the browser download manager without
  // prompting for every item.
  if (savePickerAttempted || !canUseFileSystemStream()) return null;
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
    if (error instanceof DOMException && error.name === 'AbortError') {
      savePickerAttempted = false;
      throw error;
    }
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

export function resolveWorkerAssetUrl(
  generatedUrl: URL,
  baseUri: string,
  appScriptUrls: readonly string[] = []
) {
  // Vite's IIFE compatibility transform normally uses document.currentScript
  // as the base. Module/deferred scripts can report it as null, which makes a
  // GitHub Pages URL resolve at the site root instead of /assets/. Always
  // prefer the path of the actual application bundle when it is available so
  // the repository base path is retained even if the generated URL looks like
  // an otherwise valid /assets URL.
  const fileName = generatedUrl.pathname.split('/').pop();
  if (!fileName || !/^web-download\.worker-[\w-]+\.js$/.test(fileName)) return generatedUrl;
  const appScript = appScriptUrls
    .find((src) => /(?:^|\/)assets\/index-[^/]+\.js(?:[?#]|$)/.test(src));
  const rebasedUrl = appScript
    ? new URL(fileName, appScript)
    : new URL(`./assets/${fileName}`, baseUri);
  if (rebasedUrl.href !== generatedUrl.href) {
    console.warn('[SirenRecords] rebased Worker URL for static hosting', {
      generated: generatedUrl.href,
      resolved: rebasedUrl.href
    });
  }
  return rebasedUrl;
}

function usesBrowserManagedDownload() {
  return browserDownloadNeedsUserGesture(
    pickerIsAvailable(),
    directoryPickerIsAvailable(),
    Boolean(downloadDirectoryHandle),
    savePickerAttempted
  );
}

function synchronousDownloadEndpoint(id: string) {
  const apiBase = getConfiguredApiBase();
  const staticFileMode = typeof location !== 'undefined' && location.protocol === 'file:' && !apiBase;
  return {
    endpoint: apiBase
      ? resolveApiUrl(`/api/audio?id=${encodeURIComponent(id)}`, apiBase)
      : `/api/audio?id=${encodeURIComponent(id)}`,
    staticFileMode
  };
}

function recentBlockingProxyError() {
  if (!recentProxyFailure || Date.now() - recentProxyFailure.checkedAt > 60_000) return null;
  return /HTTP\s*402|deployment.*paused|temporarily paused|代理服务已暂停/i.test(recentProxyFailure.message)
    ? new Error(recentProxyFailure.message)
    : null;
}

async function finishBrowserManagedDownload(request: DownloadRequest) {
  try {
    await saveDownloadRecord({
      cid: request.id,
      name: request.title || request.id,
      filename: request.fileName || `${request.id}.wav`,
      size: 0,
      downloadedAt: Date.now(),
      status: 'handed_off'
    });
  } finally {
    activeDownloads.delete(request.id);
    emit('complete', { id: request.id, outcome: 'handed_off' });
  }
}

function resolveWorkerUrl(generatedUrl: URL) {
  if (typeof document === 'undefined') return generatedUrl;
  return resolveWorkerAssetUrl(
    generatedUrl,
    document.baseURI,
    Array.from(document.scripts).map((script) => script.src)
  );
}

function workerErrorFromEvent(event: ErrorEvent, workerUrl?: URL) {
  const detail = [
    event.message,
    event.filename && `${event.filename}:${event.lineno || 0}:${event.colno || 0}`
  ].filter(Boolean).join(' · ');
  const fallback = `Worker 加载或运行失败${workerUrl ? `（${workerUrl.href}）` : ''}`;
  const error = normalizeDownloadError(event.error || new Error(detail || fallback));
  if (!error.message && detail) error.message = detail;
  if (!error.message) error.message = fallback;
  return error;
}

function isDownloadWorkerMessage(value: unknown): value is DownloadWorkerMessage {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string');
}

async function runMainThreadFallback(
  request: DownloadRequest,
  endpoint: string,
  active: ActiveDownload,
  fileHandle: FileHandleLike
): Promise<number> {
  const response = await fetch(endpoint, {
    cache: 'no-store',
    credentials: 'omit',
    signal: active.controller.signal
  });
  if (!response.ok) throw new Error(await readError(response, `HTTP ${response.status}`));
  const contentLength = Number(response.headers.get('content-length'));
  const total = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
  const startedAt = performance.now();
  request.fileName = responseFileName(
    response.headers.get('content-disposition') || '',
    response.headers.get('content-type') || '',
    request.fileName || `${request.id}.audio`
  );
  const writer = await fileHandle.createWritable();
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('浏览器无法读取音频响应流');
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
    if (!isCompleteDownloadSize(loaded, total)) {
      throw new Error(`音频下载不完整：应为 ${total} 字节，实际为 ${loaded} 字节`);
    }
    await writer.close();
    return loaded;
  } catch (error) {
    if (writer.abort) await writer.abort(error).catch(() => undefined);
    throw error;
  }
}

export function isCompleteDownloadSize(loaded: number, total: number | null) {
  return total === null || loaded === total;
}

async function runWorkerDownload(
  request: DownloadRequest,
  endpoint: string,
  active: ActiveDownload,
  fileHandle: FileHandleLike
): Promise<number> {
  if (active.controller.signal.aborted) throw cancelledError();
  let worker: Worker;
  // Vite emits this URL as a hashed ES-module asset. resolveWorkerUrl fixes
  // the repository base path for GitHub Pages and other static hosts before
  // constructing the module Worker.
  const generatedWorkerUrl = new URL(bundledWorkerUrl, document.baseURI);
  const workerUrl = resolveWorkerUrl(generatedWorkerUrl);
  try {
    worker = new Worker(workerUrl, { type: 'module' });
  } catch (error) {
    // Safari versions without module workers still get a functional download.
    console.warn('[SirenRecords] module Worker unavailable; using main-thread stream fallback', {
      workerUrl: workerUrl.href,
      error
    });
    return runMainThreadFallback(request, endpoint, active, fileHandle);
  }

  // Attach listeners before awaiting createWritable(). A module Worker can
  // fail while its script is loading, and that error must not disappear before
  // the queue has installed its normal message handlers.
  let bootstrapError: Error | null = null;
  const onBootstrapError = (event: ErrorEvent) => {
    const error = workerErrorFromEvent(event, workerUrl);
    bootstrapError = error;
    console.error('[SirenRecords] web download worker bootstrap error', {
      cid: request.id,
      endpoint,
      workerUrl: workerUrl.href,
      errorType: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      time: new Date().toISOString()
    }, event.error || event);
  };
  const onBootstrapMessageError = (event: MessageEvent) => {
    bootstrapError = new Error('Worker 消息无法结构化克隆');
    bootstrapError.name = 'DataCloneError';
    console.error('[SirenRecords] web download worker bootstrap message error', event);
  };
  worker.addEventListener('error', onBootstrapError);
  worker.addEventListener('messageerror', onBootstrapMessageError);

  let writer: FileWritableLike | null = null;
  worker.removeEventListener('error', onBootstrapError);
  worker.removeEventListener('messageerror', onBootstrapMessageError);
  if (bootstrapError) {
    worker.terminate();
    throw bootstrapError;
  }
  if (active.controller.signal.aborted) {
    worker.terminate();
    throw cancelledError();
  }
  active.worker = worker;
  const requestId = `${request.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const startedAt = performance.now();

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let writeChain = Promise.resolve();
    let lastLoaded = 0;
    let lastTotal: number | null = null;
    let resumeOffset = 0;
    let resumeTotal: number | null = null;
    let resumeAttempted = false;

    const cleanup = () => {
      active.controller.signal.removeEventListener('abort', cancelWorker);
      worker.terminate();
      if (active.worker === worker) active.worker = undefined;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      const normalized = normalizeDownloadError(error);
      settled = true;
      cleanup();
      if (writer?.abort) void writer.abort(normalized).catch(() => undefined);
      reject(normalized);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      void writeChain.then(async () => {
        if (writer) await writer.close();
        cleanup();
        resolve(lastLoaded);
      }).catch((error) => {
        cleanup();
        const normalized = normalizeDownloadError(error);
        if (writer?.abort) void writer.abort(normalized).catch(() => undefined);
        reject(normalized);
      });
    };
    const postWorker = (message: DownloadWorkerStart | DownloadWorkerCancel | DownloadWorkerChunkAck) => {
      try {
        worker.postMessage(message);
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    };
    const cancelWorker = () => {
      postWorker({ type: 'cancel', requestId } satisfies DownloadWorkerCancel);
    };
    active.controller.signal.addEventListener('abort', cancelWorker, { once: true });

    worker.addEventListener('message', (event: MessageEvent<DownloadWorkerMessage>) => {
      if (!isDownloadWorkerMessage(event.data)) {
        fail(new Error('Worker 返回了无法识别的消息'));
        return;
      }
      const message = event.data;
      if (message.type === 'ready') return;
      if (message.requestId !== requestId || settled) return;
      if (message.type === 'response') {
        if (resumeOffset > 0 && message.status !== 206) {
          fail(new Error('服务器不支持断点续传，请重新下载'));
          return;
        }
        lastTotal = resumeOffset > 0
          ? (resumeTotal ?? (message.contentLength === null ? null : resumeOffset + message.contentLength))
          : message.contentLength;
        request.fileName = responseFileName(
          message.contentDisposition,
          message.contentType,
          request.fileName || `${request.id}.audio`
        );
        writeChain = writeChain.then(async () => {
          writer ??= await fileHandle.createWritable();
        }).catch(fail);
        return;
      }
      if (message.type === 'chunk') {
        lastLoaded = resumeOffset + message.loaded;
        lastTotal = resumeOffset > 0
          ? (resumeTotal ?? (message.total === null ? null : resumeOffset + message.total))
          : message.total;
        writeChain = writeChain
          .then(async () => {
            writer ??= await fileHandle.createWritable();
            await writer.write(message.buffer);
          })
          .then(() => {
            emitProgress(request.id, lastLoaded, lastTotal, startedAt);
            if (!postWorker({ type: 'chunk-ack', requestId } satisfies DownloadWorkerChunkAck)) {
              throw new Error('无法确认文件写入进度');
            }
          })
          .catch((error) => {
            fail(error);
          });
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
      if (message.type === 'cancelled') return fail(cancelledError());
      if (message.type === 'failed') {
        const currentLoaded = resumeOffset + (message.loaded || 0);
        if (fileHandle && !resumeAttempted && currentLoaded > 0 && !active.controller.signal.aborted) {
          resumeAttempted = true;
          resumeOffset = currentLoaded;
          resumeTotal = lastTotal ?? message.total ?? null;
          writeChain = writeChain
            .then(async () => {
              if (!writer?.seek) throw new Error('当前浏览器不支持断点续传写入');
              await writer.seek(resumeOffset);
            })
            .then(() => {
              if (!settled) postWorker({
                type: 'start', requestId, endpoint,
                range: rangeHeaderForOffset(resumeOffset)
              } satisfies DownloadWorkerStart);
            })
            .catch((error) => { fail(error); });
          return;
        }
        const failure = new Error(message.message || '下载失败') as Error & { retryAfterSeconds?: number };
        if (message.errorName) failure.name = message.errorName;
        if (message.errorStack) failure.stack = message.errorStack;
        if (message.retryAfterSeconds) failure.retryAfterSeconds = message.retryAfterSeconds;
        return fail(failure);
      }
      if (message.type === 'complete') return finish();
    });
    worker.addEventListener('error', (event) => {
      const error = workerErrorFromEvent(event, workerUrl);
      console.error('[SirenRecords] web download worker runtime error', {
        cid: request.id,
        endpoint,
        workerUrl: workerUrl.href,
        errorType: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
        time: new Date().toISOString()
      }, event.error || event);
      fail(error);
    });
    worker.addEventListener('messageerror', (event) => {
      const error = new Error('Worker 消息无法结构化克隆');
      error.name = 'DataCloneError';
      console.error('[SirenRecords] web download worker message error', {
        cid: request.id,
        endpoint,
        errorType: error.name,
        errorMessage: error.message,
        time: new Date().toISOString()
      }, event);
      fail(error);
    });
    postWorker({ type: 'start', requestId, endpoint } satisfies DownloadWorkerStart);
  });
}

function logDownloadFailure(request: DownloadRequest, endpoint: string, error: unknown) {
  const normalized = normalizeDownloadError(error);
  console.error('[SirenRecords] web download failed', {
    cid: request.id,
    title: request.title || request.id,
    endpoint,
    browser: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    errorType: normalized.name,
    errorMessage: normalized.message,
    errorStack: normalized.stack,
    time: new Date().toISOString()
  }, error);
}

async function downloadAudio(request: DownloadRequest, active: ActiveDownload) {
  let staticFileMode = false;
  let endpoint = '';
  try {
    const fileHandle = await active.fileHandlePromise;
    if (active.controller.signal.aborted) throw cancelledError();
    const apiBase = await resolveDownloadProxy();
    staticFileMode = typeof location !== 'undefined' && location.protocol === 'file:' && !apiBase;
    if (staticFileMode) throw new Error(staticDownloadHint);
    endpoint = apiBase
      ? resolveApiUrl(`/api/audio?id=${encodeURIComponent(request.id)}`, apiBase)
      : `/api/audio?id=${encodeURIComponent(request.id)}`;
    if (!fileHandle) {
      // A browser-managed download must be opened in the same user-activation
      // task as the click. If a picker failed asynchronously, ask for a new
      // click instead of silently triggering a download that WebKit will block.
      if (!hasUserActivation()) {
        savePickerAttempted = true;
        const error = new Error('浏览器需要用户激活后才能开始下载，请点击重试');
        error.name = 'NotAllowedError';
        throw error;
      }
      handOffBrowserManagedDownload(endpoint, request.fileName || `${request.id}.wav`);
      await saveDownloadRecord({
        cid: request.id,
        name: request.title || request.id,
        filename: request.fileName || `${request.id}.wav`,
        size: 0,
        downloadedAt: Date.now(),
        status: 'handed_off'
      });
      emit('complete', { id: request.id, outcome: 'handed_off' });
      return;
    }
    const size = await runWorkerDownload(request, endpoint, active, fileHandle);
    await saveDownloadRecord({
      cid: request.id,
      name: request.title || request.id,
      filename: request.fileName || `${request.id}.wav`,
      size,
      downloadedAt: Date.now(),
      status: 'completed'
    });
    emit('complete', { id: request.id, outcome: 'completed', size });
  } catch (error) {
    logDownloadFailure(request, endpoint, error);
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
      const retryAfterSeconds = Number((error as { retryAfterSeconds?: unknown })?.retryAfterSeconds);
      emit('failed', {
        id: request.id,
        message: friendlyDownloadError(error, staticFileMode),
        ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterSeconds } : {})
      });
    }
  } finally {
    activeDownloads.delete(request.id);
  }
}

export const webPlatform: PlatformBridge = {
  kind: 'web',
  // The worker keeps network work off the Vue thread. The queue still caps the
  // defaults to one and lets the user choose one to three concurrent tasks.
  get maxConcurrentDownloads() {
    return usesBrowserManagedDownload()
      ? 1
      : webDownloadConcurrency(pickerIsAvailable(), directoryPickerIsAvailable());
  },
  get requiresUserGestureForDownload() {
    return usesBrowserManagedDownload();
  },

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

    // Safari, Firefox and most mobile browsers do not expose a writable file
    // picker. Trigger their download manager synchronously while the click is
    // still active; awaiting proxy detection first causes WebKit to block it.
    if (usesBrowserManagedDownload()) {
      if (!hasUserActivation()) {
        const error = new Error('浏览器需要用户激活后才能开始下载，请点击“继续下载下一首”');
        error.name = 'NotAllowedError';
        throw error;
      }
      const blockedProxy = recentBlockingProxyError();
      if (blockedProxy) throw new Error(friendlyDownloadError(blockedProxy, false));
      const { endpoint, staticFileMode } = synchronousDownloadEndpoint(request.id);
      if (staticFileMode) throw new Error(staticDownloadHint);
      activeDownloads.set(request.id, { controller, fileHandlePromise: Promise.resolve(null) });
      try {
        handOffBrowserManagedDownload(endpoint, request.fileName || `${request.id}.wav`);
      } catch (error) {
        activeDownloads.delete(request.id);
        throw error;
      }
      void finishBrowserManagedDownload(request);
      return { started: true };
    }
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
