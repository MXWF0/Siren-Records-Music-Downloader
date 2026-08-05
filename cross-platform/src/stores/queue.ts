import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Song } from '../catalog';
import type { PlatformBridge } from '../platform/types';
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
  sourceUrl?: string;
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
  notice: Ref<QueueNotice | null>;
  active: ComputedRef<QueueItem[]>;
  pending: ComputedRef<QueueItem[]>;
  failed: ComputedRef<QueueItem[]>;
  completed: ComputedRef<QueueItem[]>;
  enqueue(song: Song, force?: boolean): boolean;
  enqueueMany(songs: Song[], force?: boolean): number;
  runNext(settings: AppSettings): Promise<void>;
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

/** Build the same user-facing name for web downloads and desktop saves. */
export function buildSongFileName(song: Pick<Song, 'cid' | 'name' | 'albumName'>) {
  const album = safeFilePart(song.albumName, '塞壬唱片');
  const title = safeFilePart(song.name, song.cid);
  return `[${album}] ${title}.wav`;
}

export function createQueueStore(
  platform: PlatformBridge,
  downloadedIds: Ref<Set<string>>,
  onCompleted: (id: string) => void
): QueueStore {
  const items = ref<QueueItem[]>([]);
  const notice = ref<QueueNotice | null>(null);
  const active = computed(() => items.value.filter((item) => item.state === 'downloading'));
  const pending = computed(() => items.value.filter((item) => item.state === 'pending'));
  const failed = computed(() => items.value.filter((item) => item.state === 'failed'));
  const completed = computed(() => items.value.filter((item) => item.state === 'completed'));
  let currentId = '';
  let currentSettings: AppSettings | null = null;

  function notify(message: string, tone: QueueNoticeTone = 'normal') {
    notice.value = { message, tone };
  }

  function find(id: string) {
    return items.value.find((item) => item.id === String(id));
  }

  function enqueue(song: Song, force = false) {
    const existing = items.value.find((item) => item.id === song.cid);
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
        sourceUrl: song.sourceUrl,
        fileName: buildSongFileName(song)
      });
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
      sourceUrl: song.sourceUrl,
      fileName: buildSongFileName(song)
    });
    return true;
  }

  function enqueueMany(songs: Song[], force = false) {
    return songs.reduce((count, song) => count + (enqueue(song, force) ? 1 : 0), 0);
  }

  async function runNext(settings: AppSettings) {
    currentSettings = settings;
    if (currentId) return;
    const next = pending.value[0];
    if (!next) return;
    currentId = next.id;
    next.state = 'downloading';
    next.message = undefined;
    try {
      const result = await platform.startDownload({
        id: next.id,
        downloadDirectory: '',
        outputFormat: 'wav',
        separateDirectory: settings.separateDirectory,
        sourceUrl: next.sourceUrl,
        fileName: next.fileName
      });
      if (!result.started) throw new Error('下载任务未能启动');
      if (next.state === 'downloading') notify(`正在下载「${next.title}」`);
    } catch (error) {
      next.state = 'failed';
      next.message = error instanceof Error ? error.message : '无法启动下载';
      currentId = '';
      notify(next.message, 'error');
      void runNext(settings);
    }
  }

  async function cancel(id: string) {
    const item = find(id);
    if (!item) return;
    if (item.state === 'pending' || item.state === 'failed') {
      items.value = items.value.filter((entry) => entry.id !== id);
      notify('已从下载队列移除', 'success');
      return;
    }
    if (item.state !== 'downloading' || item.cancelling) return;
    item.cancelling = true;
    try {
      const cancelled = await platform.cancelDownload(id);
      if (!cancelled) {
        item.cancelling = false;
        notify('下载任务已发生变化，请重试', 'error');
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
    item.state = 'pending';
    item.progress = 0;
    item.loaded = 0;
    item.total = null;
    item.rate = 0;
    item.etaSeconds = null;
    item.message = undefined;
    notify(`已重新加入「${item.title}」`, 'success');
    await runNext(settings);
  }

  function clearHistory() {
    items.value = items.value.filter((item) => item.state === 'pending' || item.state === 'downloading');
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
        item.state = 'completed';
        item.progress = 100;
        item.cancelling = false;
        currentId = '';
        onCompleted(value.id);
        notify(`「${item.title}」下载完成`, 'success');
        void advance();
      },
      failed(value) {
        const item = find(value.id);
        if (!item) return;
        item.state = 'failed';
        item.message = value.message || '下载失败，请重试';
        item.cancelling = false;
        currentId = '';
        notify(`「${item.title}」下载失败`, 'error');
        void advance();
      },
      cancelled(value) {
        const item = find(value.id);
        if (!item) return;
        item.state = 'cancelled';
        item.message = '已取消下载';
        item.cancelling = false;
        currentId = '';
        notify(`已取消「${item.title}」`, 'success');
        void advance();
      }
    });
  }

  return { items, notice, active, pending, failed, completed, enqueue, enqueueMany, runNext, cancel, retry, clearHistory, connect };
}
