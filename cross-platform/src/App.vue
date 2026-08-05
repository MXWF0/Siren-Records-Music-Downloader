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
const selectedSong = ref<Song | null>(null);
const settings = reactive<AppSettings>({ ...defaultSettings });
const platformInfo = ref<PlatformInfo>({ os: '正在识别', arch: '—', appVersion: 'v1.1', runtime: '—' });
const ready = ref(false);
const status = ref('正在加载本地设置');
const statusTone = ref<'normal' | 'success' | 'error'>('normal');
const catalog = createCatalogStore(
  platform.loadOfficialCatalog
    ? () => platform.loadOfficialCatalog!()
    : undefined
);
const queue = createQueueStore(platform, catalog.downloadedIds, catalog.markDownloaded);
const currentDownload = computed(() => queue.active.value[0] ?? null);
let saveQueue = Promise.resolve();
let disposeDownloadEvents: (() => void) | undefined;

function setStatus(message: string, tone: 'normal' | 'success' | 'error' = 'normal') {
  status.value = message;
  statusTone.value = tone;
}

function updateSettings(changes: Partial<AppSettings>) {
  Object.assign(settings, normalizeSettings({ ...settings, ...changes }));
}

function enqueue(song: Song, force = false) {
  const added = queue.enqueue(song, force);
  setStatus(added ? `已加入「${song.name}」` : '歌曲已在队列中或已经下载', added ? 'success' : 'normal');
  if (added) void queue.runNext(settings);
}

function enqueueMany(songs: Song[], force = false) {
  const count = queue.enqueueMany(songs, force);
  setStatus(count ? `已加入 ${count} 首歌曲到下载队列` : '所选歌曲已在队列中或已经下载', count ? 'success' : 'normal');
  if (count) void queue.runNext(settings);
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

onMounted(async () => {
  const [storedSettings, info] = await Promise.allSettled([
    platform.getSettings(),
    platform.getPlatformInfo(),
    catalog.load()
  ]);
  if (storedSettings.status === 'fulfilled') Object.assign(settings, storedSettings.value);
  else setStatus('本地设置加载失败，但仍可继续使用', 'error');
  if (info.status === 'fulfilled') platformInfo.value = info.value;
  ready.value = true;
  disposeDownloadEvents = await queue.connect();
  if (catalog.errorMessage.value) {
    setStatus(catalog.errorMessage.value, catalog.previewData.value ? 'normal' : 'error');
  } else if (storedSettings.status === 'fulfilled') {
    setStatus('跨平台界面与下载队列已就绪', 'success');
  }
  if (platform.kind === 'tauri') {
    try {
      await platform.recoverDownloads('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法清理上次未完成的临时文件', 'error');
    }
  }
});

onUnmounted(() => disposeDownloadEvents?.());
</script>

<template>
  <div class="app-shell stage-two-shell">
    <TitleBar :active-view="activeView" :window-controls="platform.windowControls" @navigate="activeView = $event" />

    <main class="stage-two-main">
      <CatalogPage v-if="activeView === 'library'" :catalog="catalog" :group-by-download="settings.groupByDownload" @enqueue="enqueue" @enqueue-many="enqueueMany" @details="selectedSong = $event" @status="setStatus" />
      <AboutPage v-else :platform-info="platformInfo" :settings="settings" @update-settings="updateSettings" />
    </main>

    <footer v-if="activeView === 'library'" class="stage-two-footer" :data-tone="statusTone">
      <div v-if="currentDownload" class="footer-download" aria-live="polite">
        <span class="status-indicator active" aria-hidden="true"></span>
        <span class="footer-download-title">{{ currentDownload.title }}</span>
        <div class="footer-progress" aria-hidden="true"><span :style="{ width: `${currentDownload.progress}%` }"></span></div>
        <strong>{{ currentDownload.total ? `${currentDownload.progress}%` : '下载中' }}</strong>
        <small v-if="currentDownload.rate">{{ (currentDownload.rate / 1024 / 1024).toFixed(1) }} MB/s</small>
      </div>
      <div v-else class="footer-status"><span class="status-indicator" aria-hidden="true"></span><span>{{ status }}</span></div>
      <div class="footer-actions"><button type="button" class="queue-launcher" :class="{ highlighted: queue.items.value.length }" @click="showQueue = true"><span class="queue-launch-icon">≋</span>下载队列 <b v-if="queue.items.value.length">{{ queue.items.value.length }}</b></button></div>
    </footer>

    <QueuePanel :queue="queue" :settings="settings" :open="showQueue" @close="showQueue = false" @status="setStatus" />
    <SongDetailModal :song="selectedSong" @close="selectedSong = null" />
  </div>
</template>
