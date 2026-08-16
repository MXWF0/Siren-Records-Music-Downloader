/**
 * Web download worker.
 *
 * The worker owns the network request and reports small progress messages to
 * the Vue thread. Each response chunk is transferred to the main thread, which
 * owns the permission-gated FileSystemWritableFileStream.
 */

interface StartMessage {
  type: 'start';
  requestId: string;
  endpoint: string;
  range?: string;
}

interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

interface ChunkAckMessage {
  type: 'chunk-ack';
  requestId: string;
}

type WorkerRequest = StartMessage | CancelMessage | ChunkAckMessage;

interface ResponseMessage {
  type: 'response';
  requestId: string;
  status: number;
  contentType: string;
  contentLength: number | null;
  contentDisposition: string;
}

interface ChunkMessage {
  type: 'chunk';
  requestId: string;
  buffer: ArrayBuffer;
  loaded: number;
  total: number | null;
}

interface ProgressMessage {
  type: 'progress';
  requestId: string;
  loaded: number;
  total: number | null;
}

interface TerminalMessage {
  type: 'complete' | 'cancelled' | 'failed';
  requestId: string;
  message?: string;
  errorName?: string;
  errorStack?: string;
  loaded?: number;
  total?: number | null;
  retryAfterSeconds?: number;
}

interface ReadyMessage {
  type: 'ready';
}

type WorkerResponse = ReadyMessage | ResponseMessage | ChunkMessage | ProgressMessage | TerminalMessage;

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
const controllers = new Map<string, AbortController>();
const chunkAcknowledgements = new Map<string, () => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.requestId !== 'string') return false;
  if (value.type === 'cancel' || value.type === 'chunk-ack') return true;
  return value.type === 'start'
    && typeof value.endpoint === 'string'
    && (value.range === undefined || typeof value.range === 'string');
}

/**
 * Keep at most one transferred audio chunk waiting in the main thread. Without
 * this acknowledgement a fast network can fill the Worker message queue while
 * a slower disk is still writing, which is especially costly on mobile.
 */
function waitForChunkAcknowledgement(requestId: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      chunkAcknowledgements.delete(requestId);
      reject(new DOMException('下载已取消', 'AbortError'));
    };
    chunkAcknowledgements.set(requestId, () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorDetails(error: unknown) {
  if (error instanceof Error) return { message: error.message, name: error.name, stack: error.stack };
  if (isRecord(error)) {
    return {
      message: typeof error.message === 'string' ? error.message : String(error),
      name: typeof error.name === 'string' ? error.name : 'Error',
      stack: typeof error.stack === 'string' ? error.stack : undefined
    };
  }
  return { message: String(error || '下载失败'), name: 'Error', stack: undefined };
}

function post(message: WorkerResponse, transfer?: Transferable[]) {
  workerScope.postMessage(message, transfer);
}

async function responseError(response: Response) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 240).trim();
  } catch {
    // The response may be closed by the proxy after an upstream failure.
  }
  if (/temporarily paused|deployment.*paused/i.test(detail)) return '下载代理服务已暂停';
  // Do not surface an HTML error document from an upstream platform.
  if (/^<!doctype|^<html/i.test(detail)) return `HTTP ${response.status}`;
  return detail || `HTTP ${response.status}`;
}

function retryAfterSeconds(response: Response) {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function isAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('下载已取消', 'AbortError'));
    }, { once: true });
  });
}

async function fetchWithRetry(message: StartMessage, signal: AbortSignal) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(message.endpoint, {
        cache: 'no-store',
        credentials: 'omit',
        headers: message.range ? { Range: message.range } : undefined,
        signal
      });
      // Retry transient proxy/CDN responses before any body is consumed. This
      // avoids duplicating bytes already written to a FileSystem writer.
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
      // Rate limiting is coordinated by the queue from Retry-After so all
      // concurrent tasks stop together instead of each worker retrying early.
      if (response.status === 429) return response;
      await response.body?.cancel().catch(() => undefined);
      await wait(attempt === 0 ? 500 : 1_200, signal);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      lastError = error;
      if (attempt === 2) throw error;
      await wait(attempt === 0 ? 500 : 1_200, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('网络请求失败');
}

async function runDownload(message: StartMessage) {
  const controller = new AbortController();
  controllers.set(message.requestId, controller);
  let loaded = 0;
  let total: number | null = null;
  let retryAfter: number | undefined;
  try {
    const response = await fetchWithRetry(message, controller.signal);
    if (!response.ok) {
      retryAfter = response.status === 429 ? retryAfterSeconds(response) : undefined;
      const detail = await responseError(response);
      throw new Error(`HTTP ${response.status}${detail && !/^HTTP\s+\d+/i.test(detail) ? `：${detail}` : ''}`);
    }

    const totalHeader = Number(response.headers.get('content-length'));
    total = Number.isFinite(totalHeader) && totalHeader >= 0 ? totalHeader : null;
    post({
      type: 'response',
      requestId: message.requestId,
      status: response.status,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      contentLength: total,
      contentDisposition: response.headers.get('content-disposition') || ''
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('浏览器无法读取音频响应流');
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      const chunk = result.value;
      loaded += chunk.byteLength;
      const buffer = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk.buffer
        : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      post({ type: 'chunk', requestId: message.requestId, buffer, loaded, total }, [buffer]);
      await waitForChunkAcknowledgement(message.requestId, controller.signal);
    }
    if (total !== null && loaded !== total) {
      throw new Error(`音频下载不完整：应为 ${total} 字节，实际为 ${loaded} 字节`);
    }
    post({ type: 'complete', requestId: message.requestId });
  } catch (error) {
    if (isAbort(error, controller.signal)) {
      post({ type: 'cancelled', requestId: message.requestId });
    } else {
      const details = errorDetails(error);
      console.error('[SirenRecords] web download worker failed', {
        requestId: message.requestId,
        endpoint: message.endpoint,
        errorType: details.name,
        errorMessage: details.message,
        errorStack: details.stack,
        time: new Date().toISOString()
      }, error);
      post({
        type: 'failed',
        requestId: message.requestId,
        message: details.message,
        errorName: details.name,
        errorStack: details.stack,
        loaded,
        total,
        retryAfterSeconds: retryAfter
      });
    }
  } finally {
    chunkAcknowledgements.delete(message.requestId);
    controllers.delete(message.requestId);
  }
}

workerScope.addEventListener('message', (event) => {
  const message = event.data;
  if (!isWorkerRequest(message)) {
    console.error('[SirenRecords] web download worker received an invalid message', message);
    return;
  }
  if (message.type === 'cancel') {
    controllers.get(message.requestId)?.abort();
    return;
  }
  if (message.type === 'chunk-ack') {
    const acknowledge = chunkAcknowledgements.get(message.requestId);
    chunkAcknowledgements.delete(message.requestId);
    acknowledge?.();
    return;
  }
  void runDownload(message);
});

// A small boot message makes module-loading failures distinguishable from a
// network failure when the main thread is debugging a static deployment.
post({ type: 'ready' });
