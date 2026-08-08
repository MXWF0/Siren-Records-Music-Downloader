import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Song } from '../catalog';
import type { PersistedQueueTask, PlatformBridge } from '../platform/types';
import type { AppSettings } from '../settings';

export type QueueState = 'pending' | 'downloading' | 'failed' | 'completed' | 'cancelled';
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
  enqueue(song: Song, force?: boolean): boolean;
  enqueueMany(songs: Song[], force?: boolean): number;
  restore(): Promise<void>;
  runNext(settings: AppSettings): Promise<void>;
  togglePaused(settings: AppSettings): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string, settings: AppSettings): Promise<void>;
  clearHistory(): void;
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

/** The proxy may correct the extension when the official source is not WAV. */
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
  const activeIds = new Set<string>();
  const startingIds = new Set<string>();
  let currentSettings: AppSettings | null = null;
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
    if (existing && force && ['completed', 'failed', 'cancelled'].includes(existing.state)) {
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
    const restored = stored.tasks
      .map(queueItemFromTask)
      .filter((item): item is QueueItem => Boolean(item))
      .filter((item, index, values) => values.findIndex((value) => value.id === item.id) === index)
      .filter((item) => !downloadedIds.value.has(item.id));
    items.value = restored;
    paused.value = Boolean(stored.paused);
    persist();
  }

  async function runNext(settings: AppSettings) {
    currentSettings = settings;
    if (paused.value) return;
    const requestedLimit = Number(settings.concurrentDownloads);
    const configuredLimit = Number.isInteger(requestedLimit) ? Math.min(3, Math.max(1, requestedLimit)) : 2;
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
          downloadDirectory: '',
          separateDirectory: settings.separateDirectory,
          fileName: next.fileName
        });
        if (!result.started) throw new Error('下载任务未能启动');
        startingIds.delete(next.id);
        if (next.state === 'downloading') {
          activeIds.add(next.id);
          notify(`正在下载《${next.title}》`);
        }
      } catch (error) {
        startingIds.delete(next.id);
        next.state = 'failed';
        next.message = error instanceof Error ? error.message : '无法启动下载';
        notify(next.message, 'error');
        persist();
      }
    }
  }

  async function togglePaused(settings: AppSettings) {
    paused.value = !paused.value;
    persist();
    notify(paused.value ? '队列已暂停，不再启动新的下载' : '队列已继续', 'success');
    if (!paused.value) await runNext(settings);
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
    await runNext(settings);
  }

  function clearHistory() {
    items.value = items.value.filter((item) => item.state === 'pending' || item.state === 'downloading');
    persist();
    notify('已清理完成、失败和取消记录', 'success');
  }

  async function advance() {
    if (currentSettings) await runNext(currentSettings);
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
        Object.assign(item, {
          state: 'completed',
          progress: 100,
          cancelling: false,
          message: value.browserManaged ? '已交给浏览器下载管理器' : '下载完成'
        });
        onCompleted(value.id);
        persist();
        notify(value.browserManaged ? `《${item.title}》已交给浏览器下载` : `《${item.title}》下载完成`, 'success');
        void advance();
      },
      failed(value) {
        const item = find(value.id);
        if (!item) return;
        activeIds.delete(value.id);
        startingIds.delete(value.id);
        Object.assign(item, {
          state: 'failed', message: value.message || '下载失败，请重试', cancelling: false
        });
        persist();
        notify(`《${item.title}》下载失败`, 'error');
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
      }
    });
  }

  return {
    items, paused, notice, active, pending, failed, completed,
    enqueue, enqueueMany, restore, runNext, togglePaused, cancel, retry, clearHistory, connect
  };
}
