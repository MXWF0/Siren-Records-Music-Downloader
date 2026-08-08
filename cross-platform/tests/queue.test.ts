import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { createQueueStore } from '../src/stores/queue';
import type { Song } from '../src/catalog';
import type { PlatformBridge } from '../src/platform/types';

const songs: Song[] = [
  { cid: '1', name: '第一首', albumCid: 'a', albumName: '专辑 A' },
  { cid: '2', name: '第二首', albumCid: 'a', albumName: '专辑 A' }
];

describe('queue store', () => {
  it('deduplicates queued and already downloaded songs', () => {
    const store = createQueueStore(webPreviewPlatform, ref(new Set(['2'])), () => {});
    expect(store.enqueue(songs[0])).toBe(true);
    expect(store.enqueue(songs[0])).toBe(false);
    expect(store.enqueue(songs[1])).toBe(false);
    expect(store.pending.value.map((item) => item.id)).toEqual(['1']);
    expect(store.items.value[0].fileName).toBe('[专辑 A] 第一首.wav');
  });

  it('cancels one queue item and retries failed items', async () => {
    const store = createQueueStore(webPreviewPlatform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.cancel('1');
    expect(store.items.value).toHaveLength(0);

    const retryStore = createQueueStore(retryPlatform, ref(new Set<string>()), () => {});
    retryStore.enqueue(songs[0]);
    retryStore.items.value[0].state = 'failed';
    retryStore.items.value[0].message = '网络错误';
    await retryStore.retry('1', { schemaVersion: 2, separateDirectory: true, groupByDownload: true, concurrentDownloads: 2 });
    expect(retryStore.active.value).toHaveLength(1);
  });

  it('starts browser downloads instead of leaving them pending', async () => {
    let requestId = '';
    let requestKeys: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async (request) => {
        requestId = request.id;
        requestKeys = Object.keys(request);
        return { started: true };
      }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.runNext({ schemaVersion: 2, separateDirectory: false, groupByDownload: true, concurrentDownloads: 2 });
    expect(requestId).toBe('1');
    expect(requestKeys).not.toContain('sourceUrl');
    expect(store.active.value).toHaveLength(1);
  });

  it('marks a task failed when a platform declines to start it', async () => {
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async () => ({ started: false })
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.runNext({ schemaVersion: 2, separateDirectory: false, groupByDownload: true, concurrentDownloads: 2 });
    expect(store.failed.value[0]?.message).toBe('下载任务未能启动');
  });

  it('starts no more than the configured concurrent downloads', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async (request) => {
        started.push(request.id);
        return { started: true };
      }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueueMany([...songs, { cid: '3', name: '第三首', albumCid: 'b', albumName: '专辑 B' }]);
    await store.runNext({ schemaVersion: 2, separateDirectory: false, groupByDownload: true, concurrentDownloads: 2 });
    expect(started).toEqual(['1', '2']);
    expect(store.active.value).toHaveLength(2);
    expect(store.pending.value.map((item) => item.id)).toEqual(['3']);
  });

  it('restores unfinished tasks and converts interrupted downloads to pending', async () => {
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      loadQueueState: async () => ({
        version: 1,
        paused: true,
        tasks: [
          { id: '1', title: '第一首', album: '专辑 A', state: 'downloading', force: false },
          { id: '2', title: '第二首', album: '专辑 A', state: 'failed', force: false, message: '网络错误' }
        ]
      })
    };
    const store = createQueueStore(platform, ref(new Set(['2'])), () => {});
    await store.restore();
    expect(store.paused.value).toBe(true);
    expect(store.pending.value.map((item) => item.id)).toEqual(['1']);
  });

  // The retry platform acknowledges a retry without a browser/network side effect.
  const retryPlatform: PlatformBridge = {
    ...webPreviewPlatform,
    startDownload: async () => ({ started: true })
  };
});

const webPreviewPlatform: PlatformBridge = {
  kind: 'web',
  getSettings: async () => ({ schemaVersion: 2, separateDirectory: true, groupByDownload: true, concurrentDownloads: 2 }),
  saveSettings: async () => {},
  selectDirectory: async () => null,
  validateDownloadDirectory: async () => {},
  loadDownloadedIds: async () => [],
  loadQueueState: async () => null,
  saveQueueState: async () => {},
  getPlatformInfo: async () => ({ os: 'test', arch: 'test', appVersion: 'test', runtime: 'test' }),
  recoverDownloads: async () => {},
  startDownload: async () => ({ started: false }),
  cancelDownload: async () => false,
  listenDownloadEvents: async () => () => {}
};
