<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import AboutPage from './components/AboutPage.vue';
import CatalogPage from './components/CatalogPage.vue';
import QueuePanel from './components/QueuePanel.vue';
import SongDetailModal from './components/SongDetailModal.vue';
import TitleBar from './components/TitleBar.vue';
import type { Song } from './catalog';
import { platform, type PlatformInfo } from './platform';
import { defaultSettings, normalizeSettings, type AppSettings } from './settings';
import { createCatalogStore } from './stores/catalog';
import { createQueueStore } from './stores/queue';

type ViewName = 'library' | 'about';

const activeView = ref<ViewName>('library');
const showQueue = ref(false);
const queueLauncher = ref<HTMLButtonElement | null>(null);
const detailLauncher = ref<HTMLElement | null>(null);
let detailSongId = '';
const showBackToTop = ref(false);
const selectedSong = ref<Song | null>(null);
const settings = reactive<AppSettings>({ ...defaultSettings });
const platformInfo = ref<PlatformInfo>({
  os: '正在识别', arch: '—', appVersion: `v${__APP_VERSION__}`, runtime: '—'
});
const ready = ref(false);
const status = ref('正在加载本地设置');
const statusTone = ref<'normal' | 'success' | 'error'>('normal');
const catalog = createCatalogStore(platform.loadOfficialCatalog
  ? () => platform.loadOfficialCatalog!()
  : undefined);
const queue = createQueueStore(platform, catalog.downloadedIds, catalog.markDownloaded);
const currentDownload = computed(() => queue.active.value[0] ?? null);
const currentProgress = computed(() => {
  const item = currentDownload.value;
  if (!item) return null;
  const eta = item.etaSeconds == null
    ? ''
    : item.etaSeconds < 60
      ? ` · 约 ${Math.ceil(item.etaSeconds)} 秒`
      : ` · 约 ${Math.ceil(item.etaSeconds / 60)} 分钟`;
  const speed = item.rate > 0 ? `${(item.rate / 1024 / 1024).toFixed(1)} MB/s` : '正在连接';
  return `${speed}${eta}`;
});
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
let saveQueue = Promise.resolve();
let disposeDownloadEvents: (() => void) | undefined;

function setStatus(message: string, tone: 'normal' | 'success' | 'error' = 'normal') {
  status.value = message;
  statusTone.value = tone;
}

function updateSettings(changes: Partial<AppSettings>) {
  Object.assign(settings, normalizeSettings({ ...settings, ...changes }));
  void queue.runNext(settings);
}

async function chooseDownloadDirectory() {
  try {
    const directory = await platform.selectDirectory();
    if (!directory) return;
    await platform.validateDownloadDirectory(directory);
    updateSettings({ downloadDirectory: directory });
    setStatus('下载目录已更新', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '无法选择下载目录', 'error');
  }
}

async function openDownloadDirectory() {
  try {
    if (!platform.openDownloadDirectory) return;
    await platform.openDownloadDirectory();
    setStatus('已打开下载目录', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '无法打开下载目录', 'error');
  }
}

function enqueue(song: Song, force = false) {
  const added = queue.enqueue(song, force);
  setStatus(added ? `已加入《${song.name}》` : '歌曲已在队列中或已经下载', added ? 'success' : 'normal');
  if (added && online.value) void queue.runNext(settings);
}

function enqueueMany(songs: Song[], force = false) {
  const count = queue.enqueueMany(songs, force);
  setStatus(count ? `已加入 ${count} 首歌曲到下载队列` : '所选歌曲已在队列中或已经下载', count ? 'success' : 'normal');
  if (count && online.value) void queue.runNext(settings);
}

function updateNetworkState() {
  online.value = navigator.onLine;
  void queue.setNetworkAvailable(online.value, settings);
}

function updateBackToTop() {
  showBackToTop.value = window.scrollY > 480;
}

function backToTop() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

watch(settings, (value) => {
  if (!ready.value) return;
  const snapshot = normalizeSettings(value);
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => platform.saveSettings(snapshot))
    .then(() => setStatus('设置已保存', 'success'))
    .catch((error) => setStatus(error instanceof Error ? error.message : '设置保存失败', 'error'));
}, { deep: true });

watch(queue.notice, (value) => {
  if (value) setStatus(value.message, value.tone);
});

async function initializeApp() {
  const [storedSettings, info, , downloaded] = await Promise.allSettled([
    platform.getSettings(),
    platform.getPlatformInfo(),
    catalog.load(),
    platform.loadDownloadedIds()
  ]);
  if (storedSettings.status === 'fulfilled') Object.assign(settings, storedSettings.value);
  else setStatus('本地设置加载失败，但仍可继续使用', 'error');
  if (info.status === 'fulfilled') platformInfo.value = info.value;
  if (downloaded.status === 'fulfilled') catalog.replaceDownloaded(downloaded.value);
  else if (platform.kind === 'tauri') catalog.replaceDownloaded([]);

  const initializationErrors: string[] = [];
  if (platform.kind === 'tauri') {
    try {
      await platform.recoverDownloads(settings.downloadDirectory);
    } catch (error) {
      initializationErrors.push(error instanceof Error ? error.message : '无法恢复上次未完成的下载');
    }
  }
  ready.value = true;
  let queueConnected = false;
  try {
    disposeDownloadEvents = await queue.connect();
    queueConnected = true;
  } catch (error) {
    initializationErrors.push(error instanceof Error ? error.message : '下载事件连接失败');
    console.error('[SirenRecords] queue event initialization failed', error);
  }
  try {
    await queue.restore();
  } catch (error) {
    initializationErrors.push(error instanceof Error ? error.message : '下载队列恢复失败');
    console.error('[SirenRecords] queue restore failed', error);
  }
  await queue.setNetworkAvailable(online.value, settings);
  if (queueConnected && !queue.paused.value) {
    try {
      await queue.runNext(settings);
    } catch (error) {
      initializationErrors.push(error instanceof Error ? error.message : '下载队列启动失败');
      console.error('[SirenRecords] queue start failed', error);
    }
  }

  if (initializationErrors.length) {
    setStatus(initializationErrors[0], 'error');
  } else if (catalog.errorMessage.value) {
    setStatus(catalog.errorMessage.value, catalog.previewData.value ? 'normal' : 'error');
  } else if (storedSettings.status === 'fulfilled') {
    setStatus('音乐目录和下载队列已就绪', 'success');
  }
}

function openQueue() {
  // WebKit does not always focus a button after a pointer click. Explicitly
  // focus the opener so the dialog can restore a deterministic target.
  queueLauncher.value?.focus();
  showQueue.value = true;
}

function openSongDetails(song: Song, opener?: HTMLElement) {
  detailLauncher.value = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  detailSongId = song.cid;
  selectedSong.value = song;
}

function closeSongDetails() {
  selectedSong.value = null;
  const opener = detailLauncher.value;
  const songId = detailSongId;
  const restore = () => {
    const target = opener?.isConnected
      ? opener
      : document.querySelector<HTMLElement>(`[data-song-id="${CSS.escape(songId)}"] .icon-action`);
    target?.focus({ preventScroll: true });
  };
  restore();
  requestAnimationFrame(restore);
  window.setTimeout(restore, 200);
  detailLauncher.value = null;
  detailSongId = '';
}

onMounted(() => {
  window.addEventListener('scroll', updateBackToTop, { passive: true });
  window.addEventListener('online', updateNetworkState);
  window.addEventListener('offline', updateNetworkState);
  updateBackToTop();
  void initializeApp().catch((error) => {
    ready.value = true;
    console.error('[SirenRecords] application initialization failed', error);
    setStatus(error instanceof Error ? error.message : '应用初始化失败，但仍可继续浏览', 'error');
  });
});

onUnmounted(() => {
  disposeDownloadEvents?.();
  window.removeEventListener('scroll', updateBackToTop);
  window.removeEventListener('online', updateNetworkState);
  window.removeEventListener('offline', updateNetworkState);
});
</script>

<template>
  <div class="app-shell stage-two-shell">
    <TitleBar :active-view="activeView" :window-controls="platform.windowControls" @navigate="activeView = $event" />

    <main id="main-content" class="stage-two-main">
      <CatalogPage
        v-if="activeView === 'library'"
        :catalog="catalog"
        :group-by-download="settings.groupByDownload"
        :record-scope="platform.kind === 'web' ? '本设备下载记录' : '已验证本地文件'"
        @enqueue="enqueue"
        @enqueue-many="enqueueMany"
        @details="openSongDetails"
        @status="setStatus"
      />
      <AboutPage
        v-else
        :platform-info="platformInfo"
        :settings="settings"
        :desktop="platform.kind === 'tauri'"
        @update-settings="updateSettings"
        @choose-directory="chooseDownloadDirectory"
      />
    </main>

    <footer v-if="activeView === 'library'" class="stage-two-footer" :data-tone="statusTone">
      <div v-if="currentDownload" class="footer-download" aria-live="polite">
        <span class="status-indicator active" aria-hidden="true"></span>
        <span class="footer-download-title">{{ currentDownload.title }}</span>
        <div class="footer-progress" aria-hidden="true"><span :style="{ width: `${currentDownload.progress}%` }"></span></div>
        <strong>{{ currentDownload.total ? `${currentDownload.progress}%` : '下载中…' }}</strong>
        <small>{{ currentProgress }}</small>
      </div>
      <div v-else class="footer-status" aria-live="polite">
        <span class="status-indicator" :class="{ offline: !online }" aria-hidden="true"></span><span>{{ online ? status : '网络已断开，队列将在恢复联网后继续' }}</span>
      </div>
      <div class="footer-actions">
        <button v-if="platform.kind === 'tauri'" type="button" class="footer-link" @click="openDownloadDirectory">打开下载目录</button>
        <button ref="queueLauncher" type="button" class="queue-launcher" :class="{ highlighted: queue.unfinishedCount.value }" @click="openQueue">
          <span class="queue-launch-icon" aria-hidden="true">≋</span>下载队列
          <b v-if="queue.unfinishedCount.value">{{ queue.unfinishedCount.value }}</b>
        </button>
      </div>
    </footer>

    <QueuePanel :queue="queue" :settings="settings" :open="showQueue" @close="showQueue = false" @status="setStatus" />
    <SongDetailModal :song="selectedSong" :load-details="platform.loadSongDetails" @close="closeSongDetails" @download="enqueue($event, catalog.downloadedIds.value.has($event.cid)); closeSongDetails()" />
    <button v-if="activeView === 'library' && showBackToTop" type="button" class="back-to-top" aria-label="回到页面顶部" title="回到顶部" @click="backToTop">↑</button>
  </div>
</template>
