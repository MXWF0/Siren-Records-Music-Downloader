import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { createQueueStore } from '../src/stores/queue';
import type { Song } from '../src/catalog';
import type { PlatformBridge } from '../src/platform/types';
import { defaultSettings } from '../src/settings';

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
    await retryStore.retry('1', defaultSettings);
    expect(retryStore.active.value).toHaveLength(1);
  });

  it('starts browser downloads instead of leaving them pending', async () => {
    let requestId = '';
    let requestKeys: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      maxConcurrentDownloads: 3,
      startDownload: async (request) => {
        requestId = request.id;
        requestKeys = Object.keys(request);
        return { started: true };
      }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.runNext({ ...defaultSettings, separateDirectory: false });
    expect(requestId).toBe('1');
    expect(requestKeys).not.toContain('sourceUrl');
    expect(store.active.value).toHaveLength(1);
  });

  it('does not count a browser handoff as a confirmed completed file', async () => {
    let events: Parameters<PlatformBridge['listenDownloadEvents']>[0] | undefined;
    const completed: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async () => ({ started: true }),
      listenDownloadEvents: async (value) => { events = value; return () => {}; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), (id) => completed.push(id));
    await store.connect();
    store.enqueue(songs[0]);
    await store.runNext(defaultSettings);
    events?.complete({ id: '1', outcome: 'handed_off' });
    expect(store.handedOff.value.map((item) => item.id)).toEqual(['1']);
    expect(completed).toEqual([]);
  });

  it('marks a task failed when a platform declines to start it', async () => {
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async () => ({ started: false })
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.runNext({ ...defaultSettings, separateDirectory: false });
    expect(store.failed.value[0]?.message).toBe('下载任务未能启动');
  });

  it('starts no more than the configured concurrent downloads', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      maxConcurrentDownloads: 3,
      startDownload: async (request) => {
        started.push(request.id);
        return { started: true };
      }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueueMany([...songs, { cid: '3', name: '第三首', albumCid: 'b', albumName: '专辑 B' }]);
    await store.runNext({ ...defaultSettings, separateDirectory: false, concurrentDownloads: 2 });
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

  it('keeps a user download startable when queue restoration races with enqueue', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      loadQueueState: async () => ({
        version: 1, paused: false,
        tasks: [{ id: '1', title: '第一首', album: '专辑 A', state: 'pending', force: false }]
      }),
      startDownload: async (request) => { started.push(request.id); return { started: true }; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.restore();
    expect(store.items.value.map((item) => item.id)).toEqual(['1']);
    expect(store.paused.value).toBe(false);
    await store.runNext(defaultSettings, true);
    expect(started).toEqual(['1']);
    expect(store.active.value).toHaveLength(1);
  });

  it('lets a direct download click resume a restored web queue', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      loadQueueState: async () => ({
        version: 1, paused: false,
        tasks: [{ id: '1', title: '第一首', album: '专辑 A', state: 'pending', force: false }]
      }),
      startDownload: async (request) => { started.push(request.id); return { started: true }; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    await store.restore();
    expect(store.paused.value).toBe(true);
    store.enqueue(songs[1]);
    await store.runNext(defaultSettings, true);
    expect(started).toEqual(['1']);
    expect(store.paused.value).toBe(false);
  });

  it('starts only one browser handoff at a time on unsupported browsers', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      maxConcurrentDownloads: 1,
      startDownload: async (request) => { started.push(request.id); return { started: true }; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueueMany(songs);
    await store.runNext({ ...defaultSettings, concurrentDownloads: 3 });
    expect(started).toEqual(['1']);
    expect(store.pending.value.map((item) => item.id)).toEqual(['2']);
  });

  it('honors an explicit browser mode even when file streaming is available', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      maxConcurrentDownloads: 3,
      requiresUserGestureForDownload: false,
      startDownload: async (request) => { started.push(request.id); return { started: true }; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueueMany(songs);
    await store.runNext({ ...defaultSettings, webDownloadMode: 'browser', concurrentDownloads: 3 }, true);
    expect(started).toEqual(['1']);
    expect(store.pending.value.map((item) => item.id)).toEqual(['2']);
  });

  it('waits for a new user gesture before handing off the next album track', async () => {
    let events: Parameters<PlatformBridge['listenDownloadEvents']>[0] | undefined;
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      maxConcurrentDownloads: 1,
      requiresUserGestureForDownload: true,
      startDownload: async (request) => { started.push(request.id); return { started: true }; },
      listenDownloadEvents: async (value) => { events = value; return () => {}; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    await store.connect();
    store.enqueueMany(songs);

    await store.runNext(defaultSettings, true);
    expect(started).toEqual(['1']);
    events?.complete({ id: '1', outcome: 'handed_off' });
    await Promise.resolve();
    expect(started).toEqual(['1']);
    expect(store.needsUserResume.value).toBe(true);
    expect(store.pending.value.map((item) => item.id)).toEqual(['2']);

    await store.resumeRestored(defaultSettings);
    expect(started).toEqual(['1', '2']);
  });

  it('requires an explicit resume for restored web tasks', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      loadQueueState: async () => ({
        version: 1, paused: false,
        tasks: [{ id: '1', title: '第一首', album: '专辑 A', state: 'pending', force: false }]
      }),
      startDownload: async (request) => { started.push(request.id); return { started: true }; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    await store.restore();
    expect(store.paused.value).toBe(true);
    expect(store.needsUserResume.value).toBe(true);
    await store.runNext(defaultSettings);
    expect(started).toEqual([]);
    await store.resumeRestored(defaultSettings);
    expect(started).toEqual(['1']);
  });

  it('returns a rate-limited task to pending and delays the whole queue', async () => {
    let events: Parameters<PlatformBridge['listenDownloadEvents']>[0] | undefined;
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async (request) => { started.push(request.id); return { started: true }; },
      listenDownloadEvents: async (value) => { events = value; return () => {}; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    await store.connect();
    store.enqueueMany(songs);
    await store.runNext({ ...defaultSettings, concurrentDownloads: 1 });
    events?.failed({ id: '1', message: 'HTTP 429：请求过于频繁', retryAfterSeconds: 60 });
    await Promise.resolve();
    expect(store.pending.value.map((item) => item.id)).toEqual(['1', '2']);
    expect(started).toEqual(['1']);
  });

  it('retries all failures and clears all pending tasks in one action', async () => {
    const store = createQueueStore(retryPlatform, ref(new Set<string>()), () => {});
    store.enqueueMany(songs);
    store.items.value.forEach((item) => { item.state = 'failed'; item.message = '网络请求失败'; });
    await expect(store.retryAll({ ...defaultSettings, concurrentDownloads: 1 })).resolves.toBe(2);
    expect(store.active.value).toHaveLength(1);
    expect(store.pending.value).toHaveLength(1);
    expect(store.clearPending()).toBe(1);
    expect(store.pending.value).toHaveLength(0);
  });

  it('waits while offline and retries network failures after reconnecting', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async (request) => { started.push(request.id); return { started: true }; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.setNetworkAvailable(false, defaultSettings);
    await store.runNext(defaultSettings);
    expect(started).toEqual([]);
    store.items.value[0].state = 'failed';
    store.items.value[0].message = 'NetworkError：网络请求失败';
    await store.setNetworkAvailable(true, defaultSettings);
    expect(started).toEqual(['1']);
  });

  it('attempts a direct download click when navigator.onLine is stale', async () => {
    const started: string[] = [];
    const platform: PlatformBridge = {
      ...webPreviewPlatform,
      startDownload: async (request) => { started.push(request.id); return { started: true }; }
    };
    const store = createQueueStore(platform, ref(new Set<string>()), () => {});
    store.enqueue(songs[0]);
    await store.setNetworkAvailable(false, defaultSettings);
    await store.runNext(defaultSettings, true);
    expect(started).toEqual(['1']);
  });

  // The retry platform acknowledges a retry without a browser/network side effect.
  const retryPlatform: PlatformBridge = {
    ...webPreviewPlatform,
    startDownload: async () => ({ started: true })
  };
});

const webPreviewPlatform: PlatformBridge = {
  kind: 'web',
  getSettings: async () => defaultSettings,
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
