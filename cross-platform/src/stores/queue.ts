import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Song } from '../catalog';
import type { PersistedQueueTask, PlatformBridge } from '../platform/types';
import type { AppSettings } from '../settings';

export type QueueState = 'pending' | 'downloading' | 'failed' | 'completed' | 'handed_off' | 'cancelled';
export type QueueNoticeTone = 'normal' | 'success' | 'error';

export interface QueueItem {
  id: string;
  title: string;
  album: string;
  state: QueueState;
  progress: number;
  loaded: number;
  total: number | null;
  rate: number;
  etaSeconds: number | null;
  force: boolean;
  fileName?: string;
  message?: string;
  cancelling?: boolean;
}

export interface QueueNotice {
  message: string;
  tone: QueueNoticeTone;
}

export interface QueueStore {
  items: Ref<QueueItem[]>;
  paused: Ref<boolean>;
  notice: Ref<QueueNotice | null>;
  active: ComputedRef<QueueItem[]>;
  pending: ComputedRef<QueueItem[]>;
  failed: ComputedRef<QueueItem[]>;
  completed: ComputedRef<QueueItem[]>;
  handedOff: ComputedRef<QueueItem[]>;
  unfinishedCount: ComputedRef<number>;
  enqueue(song: Song, force?: boolean): boolean;
  enqueueMany(songs: Song[], force?: boolean): number;
  restore(): Promise<void>;
  runNext(settings: AppSettings, userInitiated?: boolean): Promise<void>;
  togglePaused(settings: AppSettings): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string, settings: AppSettings): Promise<void>;
  retryAll(settings: AppSettings): Promise<number>;
  clearPending(): number;
  clearHistory(): void;
  setNetworkAvailable(available: boolean, settings: AppSettings): Promise<void>;
  resumeRestored(settings: AppSettings): Promise<void>;
  needsUserResume: ComputedRef<boolean>;
  connect(): Promise<() => void>;
}

function safeFilePart(value: string | undefined, fallback: string) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 90);
  return cleaned || fallback;
}

/** The proxy supplies the authoritative extension in Content-Disposition. */
export function buildSongFileName(song: Pick<Song, 'cid' | 'name' | 'albumName'>) {
  const album = safeFilePart(song.albumName, '塞壬唱片');
  const title = safeFilePart(song.name, song.cid);
  return `[${album}] ${title}.wav`;
}

function queueItemFromTask(task: PersistedQueueTask): QueueItem | null {
  const id = String(task?.id || '').trim();
  if (!id) return null;
  return {
    id,
    title: String(task.title || id),
    album: String(task.album || '未分类专辑'),
    // A process cannot keep a network stream alive after the application exits.
    state: task.state === 'failed' ? 'failed' : 'pending',
    progress: 0,
    loaded: 0,
    total: null,
    rate: 0,
    etaSeconds: null,
    force: Boolean(task.force),
    fileName: task.fileName,
    message: task.state === 'failed' ? task.message : undefined
  };
}

export function createQueueStore(
  platform: PlatformBridge,
  downloadedIds: Ref<Set<string>>,
  onCompleted: (id: string) => void
): QueueStore {
  const items = ref<QueueItem[]>([]);
  const paused = ref(false);
  const notice = ref<QueueNotice | null>(null);
  const active = computed(() => items.value.filter((item) => item.state === 'downloading'));
  const pending = computed(() => items.value.filter((item) => item.state === 'pending'));
  const failed = computed(() => items.value.filter((item) => item.state === 'failed'));
  const completed = computed(() => items.value.filter((item) => item.state === 'completed'));
  const handedOff = computed(() => items.value.filter((item) => item.state === 'handed_off'));
  const unfinishedCount = computed(() => active.value.length + pending.value.length + failed.value.length);
  const activeIds = new Set<string>();
  const startingIds = new Set<string>();
  let currentSettings: AppSettings | null = null;
  let networkAvailable = true;
  let awaitingRestoredResume = false;
  let awaitingBrowserGesture = false;
  const needsUserResume = computed(() => awaitingRestoredResume || awaitingBrowserGesture);
  let rateLimitUntil = 0;
  let rateLimitTimer: ReturnType<typeof setTimeout> | undefined;
  let persistence = Promise.resolve();

  function notify(message: string, tone: QueueNoticeTone = 'normal') {
    notice.value = { message, tone };
  }

  function find(id: string) {
    return items.value.find((item) => item.id === String(id));
  }

  function persist() {
    const tasks: PersistedQueueTask[] = items.value
      .filter((item) => ['pending', 'downloading', 'failed'].includes(item.state))
      .map((item) => ({
        id: item.id,
        title: item.title,
        album: item.album,
        state: item.state as PersistedQueueTask['state'],
        force: item.force,
        fileName: item.fileName,
        message: item.message
      }));
    persistence = persistence
      .catch(() => undefined)
      .then(() => platform.saveQueueState({ version: 1, paused: paused.value, tasks }))
      .catch(() => undefined);
  }

  function enqueue(song: Song, force = false, shouldPersist = true) {
    const existing = find(song.cid);
    if (existing && force && ['completed', 'handed_off', 'failed', 'cancelled'].includes(existing.state)) {
      Object.assign(existing, {
        title: song.name,
        album: song.albumName,
        state: 'pending',
        progress: 0,
        loaded: 0,
        total: null,
        rate: 0,
        etaSeconds: null,
        message: undefined,
        cancelling: false,
        force: true,
        fileName: buildSongFileName(song)
      });
      if (shouldPersist) persist();
      return true;
    }
    if (downloadedIds.value.has(song.cid) && !force) return false;
    if (existing) return false;
    items.value.push({
      id: song.cid,
      title: song.name,
      album: song.albumName,
      state: 'pending',
      progress: 0,
      loaded: 0,
      total: null,
      rate: 0,
      etaSeconds: null,
      force,
      fileName: buildSongFileName(song)
    });
    if (shouldPersist) persist();
    return true;
  }

  function enqueueMany(songs: Song[], force = false) {
    const count = songs.reduce((total, song) => total + (enqueue(song, force, false) ? 1 : 0), 0);
    if (count) persist();
    return count;
  }

  async function restore() {
    const stored = await platform.loadQueueState();
    if (!stored || stored.version !== 1 || !Array.isArray(stored.tasks)) return;
    // A user can click download while the application is still restoring its
    // queue. Preserve those live items instead of replacing them with the
    // snapshot read from storage.
    const existingIds = new Set(items.value.map((item) => item.id));
    const restored = stored.tasks
      .map(queueItemFromTask)
      .filter((item): item is QueueItem => Boolean(item))
      .filter((item, index, values) => values.findIndex((value) => value.id === item.id) === index)
      .filter((item) => !downloadedIds.value.has(item.id));
    const restoredOnly = restored.filter((item) => !existingIds.has(item.id));
    items.value = [...items.value, ...restoredOnly];
    // Only a queue restored into an otherwise idle store requires the
    // explicit resume gesture. Items added by the current user interaction
    // must remain startable while initialization finishes.
    awaitingRestoredResume = platform.kind === 'web' && restoredOnly.length > 0 && existingIds.size === 0;
    paused.value = Boolean(stored.paused) || awaitingRestoredResume;
    if (awaitingRestoredResume) notify('已恢复上次未完成任务，请点击“继续队列”后开始下载');
    persist();
  }

  async function runNext(settings: AppSettings, userInitiated = false) {
    currentSettings = settings;
    // A direct download click is an explicit user gesture and should also
    // resume a queue that was paused only to protect restored browser tasks.
    // A manually paused queue remains paused until its dedicated control is
    // used.
    if (paused.value) {
      if (!(userInitiated && awaitingRestoredResume)) return;
      awaitingRestoredResume = false;
      paused.value = false;
      persist();
    }
    if ((!networkAvailable && !userInitiated) || Date.now() < rateLimitUntil) return;
    if (platform.requiresUserGestureForDownload && !userInitiated && pending.value.length) {
      awaitingBrowserGesture = true;
      notify('当前浏览器要求逐项确认下载，请点击“继续下载下一首”', 'normal');
      return;
    }
    if (userInitiated) awaitingBrowserGesture = false;
    if (platform.kind === 'web' && (platform.maxConcurrentDownloads ?? 1) === 1 && activeIds.size > 0) return;
    const requestedLimit = Number(settings.concurrentDownloads);
    const configuredLimit = Number.isInteger(requestedLimit) ? Math.min(3, Math.max(1, requestedLimit)) : 1;
    const limit = Math.min(configuredLimit, platform.maxConcurrentDownloads ?? 3);
    while (activeIds.size + startingIds.size < limit) {
      const next = pending.value.find((item) => !startingIds.has(item.id));
      if (!next) break;
      startingIds.add(next.id);
      next.state = 'downloading';
      next.message = undefined;
      persist();
      try {
        const result = await platform.startDownload({
          id: next.id,
          downloadDirectory: settings.downloadDirectory,
          separateDirectory: settings.separateDirectory,
          fileName: next.fileName,
          title: next.title
        });
        if (!result.started) throw new Error('下载任务未能启动');
        startingIds.delete(next.id);
        if (next.state === 'downloading') {
          activeIds.add(next.id);
          notify(`正在下载《${next.title}》`);
        }
        if (platform.kind === 'web' && (platform.maxConcurrentDownloads ?? 1) === 1) break;
      } catch (error) {
        startingIds.delete(next.id);
        next.state = 'failed';
        next.message = error instanceof Error ? error.message : '无法启动下载';
        notify(next.message, 'error');
        persist();
        if (platform.kind === 'web' && (platform.maxConcurrentDownloads ?? 1) === 1) break;
      }
    }
  }

  async function togglePaused(settings: AppSettings) {
    paused.value = !paused.value;
    if (!paused.value) {
      awaitingRestoredResume = false;
      awaitingBrowserGesture = false;
    }
    persist();
    notify(paused.value ? '队列已暂停，不再启动新的下载' : '队列已继续', 'success');
    if (!paused.value) await runNext(settings, true);
  }

  async function cancel(id: string) {
    const item = find(id);
    if (!item) return;
    if (item.state === 'pending' || item.state === 'failed') {
      items.value = items.value.filter((entry) => entry.id !== id);
      persist();
      notify('已从下载队列移除', 'success');
      return;
    }
    if (item.state !== 'downloading' || item.cancelling) return;
    item.cancelling = true;
    try {
      const cancelled = await platform.cancelDownload(id);
      if (!cancelled) {
        item.cancelling = false;
        notify('下载任务状态已发生变化，请重试', 'error');
      } else {
        notify('正在取消下载');
      }
    } catch (error) {
      item.cancelling = false;
      notify(error instanceof Error ? error.message : '取消下载失败', 'error');
    }
  }

  async function retry(id: string, settings: AppSettings) {
    const item = find(id);
    if (!item || item.state !== 'failed') return;
    Object.assign(item, {
      state: 'pending', progress: 0, loaded: 0, total: null,
      rate: 0, etaSeconds: null, message: undefined
    });
    persist();
    notify(`已重新加入《${item.title}》`, 'success');
    await runNext(settings, true);
  }

  async function retryAll(settings: AppSettings) {
    const retryable = failed.value;
    retryable.forEach((item) => Object.assign(item, {
      state: 'pending', progress: 0, loaded: 0, total: null,
      rate: 0, etaSeconds: null, message: undefined, cancelling: false
    }));
    if (retryable.length) {
      persist();
      notify(`已重新加入 ${retryable.length} 个失败任务`, 'success');
      await runNext(settings, true);
    }
    return retryable.length;
  }

  function clearPending() {
    const count = pending.value.length;
    if (!count) return 0;
    items.value = items.value.filter((item) => item.state !== 'pending');
    persist();
    notify(`已移除 ${count} 个待下载任务`, 'success');
    return count;
  }

  function clearHistory() {
    items.value = items.value.filter((item) => item.state === 'pending' || item.state === 'downloading');
    persist();
    notify('已清理完成、失败和取消记录', 'success');
  }

  async function advance() {
    if (currentSettings) await runNext(currentSettings);
  }

  async function setNetworkAvailable(available: boolean, settings: AppSettings) {
    networkAvailable = available;
    currentSettings = settings;
    if (!available) {
      notify('网络连接已断开，待下载任务将在恢复联网后继续', 'error');
      return;
    }
    const interrupted = failed.value.filter((item) =>
      /NetworkError|Failed to fetch|网络请求|网络连接|下载中断|读取超时/i.test(item.message || '')
    );
    interrupted.forEach((item) => Object.assign(item, {
      state: 'pending', progress: 0, loaded: 0, total: null,
      rate: 0, etaSeconds: null, message: undefined, cancelling: false
    }));
    if (interrupted.length) persist();
    notify(interrupted.length
      ? `网络已恢复，正在重试 ${interrupted.length} 个中断任务`
      : '网络连接已恢复', 'success');
    await runNext(settings);
  }

  async function resumeRestored(settings: AppSettings) {
    if (!awaitingRestoredResume && !awaitingBrowserGesture) return;
    const restored = awaitingRestoredResume;
    awaitingRestoredResume = false;
    awaitingBrowserGesture = false;
    paused.value = false;
    persist();
    notify(restored ? '已继续恢复的下载队列' : '正在继续下载下一首', 'success');
    await runNext(settings, true);
  }

  function applyRateLimit(seconds: number) {
    const delaySeconds = Math.min(300, Math.max(1, Math.ceil(seconds || 5)));
    rateLimitUntil = Math.max(rateLimitUntil, Date.now() + delaySeconds * 1000);
    if (rateLimitTimer) clearTimeout(rateLimitTimer);
    notify(`下载服务请求较多，队列将在 ${delaySeconds} 秒后自动继续`, 'error');
    rateLimitTimer = setTimeout(() => {
      rateLimitUntil = 0;
      rateLimitTimer = undefined;
      void advance();
    }, Math.max(0, rateLimitUntil - Date.now()));
  }

  async function connect() {
    return platform.listenDownloadEvents({
      progress(value) {
        const item = find(value.id);
        if (!item || item.state !== 'downloading') return;
        item.loaded = value.loaded;
        item.total = value.total;
        item.rate = value.rate;
        item.etaSeconds = value.etaSeconds;
        item.progress = value.total ? Math.min(100, Math.round((value.loaded / value.total) * 100)) : 0;
      },
      complete(value) {
        const item = find(value.id);
        if (!item) return;
        activeIds.delete(value.id);
        startingIds.delete(value.id);
        const handedOffToBrowser = value.outcome === 'handed_off';
        Object.assign(item, {
          state: handedOffToBrowser ? 'handed_off' : 'completed',
          progress: handedOffToBrowser ? item.progress : 100,
          cancelling: false,
          message: handedOffToBrowser ? '已交给浏览器下载管理器，应用无法确认最终保存结果' : '下载完成'
        });
        if (!handedOffToBrowser) onCompleted(value.id);
        persist();
        notify(handedOffToBrowser ? `《${item.title}》已交给浏览器下载` : `《${item.title}》下载完成`, 'success');
        void advance();
      },
      failed(value) {
        const item = find(value.id);
        if (!item) return;
        activeIds.delete(value.id);
        startingIds.delete(value.id);
        const rateLimited = Boolean(value.retryAfterSeconds || /HTTP 429|请求过于频繁/i.test(value.message || ''));
        Object.assign(item, {
          state: rateLimited ? 'pending' : 'failed',
          message: value.message || '下载失败，请重试',
          cancelling: false
        });
        if (rateLimited) {
          applyRateLimit(value.retryAfterSeconds || 5);
        }
        persist();
        if (!rateLimited) notify(`《${item.title}》下载失败`, 'error');
        void advance();
      },
      cancelled(value) {
        const item = find(value.id);
        if (!item) return;
        activeIds.delete(value.id);
        startingIds.delete(value.id);
        Object.assign(item, { state: 'cancelled', message: '已取消下载', cancelling: false });
        persist();
        notify(`已取消《${item.title}》`, 'success');
        void advance();
      },
      warning(value) {
        const item = find(value.id);
        notify(item ? `《${item.title}》：${value.message}` : value.message, 'normal');
      }
    });
  }

  return {
    items, paused, notice, active, pending, failed, completed, handedOff, unfinishedCount, needsUserResume,
    enqueue, enqueueMany, restore, runNext, togglePaused, cancel, retry, retryAll,
    clearPending, clearHistory, setNetworkAvailable, resumeRestored, connect
  };
}
