/**
 * Web download worker.
 *
 * The worker owns the network request and reports small progress messages to
 * the Vue thread.  Stream mode transfers each response chunk to the caller;
 * blob mode is kept as a compatibility fallback for browsers without the File
 * System Access API.
 */

interface StartMessage {
  type: 'start';
  requestId: string;
  endpoint: string;
  mode: 'stream' | 'blob';
  range?: string;
}

interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

type WorkerRequest = StartMessage | CancelMessage;

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

interface BlobMessage {
  type: 'blob';
  requestId: string;
  blob: Blob;
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
}

interface ReadyMessage {
  type: 'ready';
}

type WorkerResponse = ReadyMessage | ResponseMessage | ChunkMessage | BlobMessage | ProgressMessage | TerminalMessage;

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
const controllers = new Map<string, AbortController>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.requestId !== 'string') return false;
  if (value.type === 'cancel') return true;
  return value.type === 'start'
    && typeof value.endpoint === 'string'
    && (value.mode === 'stream' || value.mode === 'blob')
    && (value.range === undefined || typeof value.range === 'string');
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
  return detail || `HTTP ${response.status}`;
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(message.endpoint, {
        cache: 'no-store',
        credentials: 'omit',
        headers: message.range ? { Range: message.range } : undefined,
        signal
      });
      // Retry transient proxy/CDN responses before any body is consumed. This
      // avoids duplicating bytes already written to a FileSystem writer.
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 1) return response;
      await response.body?.cancel().catch(() => undefined);
      await wait(350, signal);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      lastError = error;
      if (attempt === 1) throw error;
      await wait(350, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('网络请求失败');
}

async function runDownload(message: StartMessage) {
  const controller = new AbortController();
  controllers.set(message.requestId, controller);
  let loaded = 0;
  let total: number | null = null;
  try {
    const response = await fetchWithRetry(message, controller.signal);
    if (!response.ok) {
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

    if (message.mode === 'blob') {
      if (!response.body) throw new Error('浏览器无法读取音频响应流');
      const blob = await response.blob();
      if (controller.signal.aborted) throw new DOMException('下载已取消', 'AbortError');
      post({ type: 'blob', requestId: message.requestId, blob, loaded: blob.size, total: total ?? blob.size });
      post({ type: 'complete', requestId: message.requestId });
      return;
    }

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
      post({ type: 'progress', requestId: message.requestId, loaded, total });
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
        total
      });
    }
  } finally {
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
  void runDownload(message);
});

// A small boot message makes module-loading failures distinguishable from a
// network failure when the main thread is debugging a static deployment.
post({ type: 'ready' });
