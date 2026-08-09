<script setup lang="ts">
import { nextTick, onBeforeUnmount } from 'vue';
import type { Song } from '../catalog';
import type { CatalogStore } from '../stores/catalog';
import SongRow from './SongRow.vue';

const props = defineProps<{
  catalog: CatalogStore;
  groupByDownload: boolean;
  recordScope: string;
}>();

const emit = defineEmits<{
  enqueue: [song: Song, force?: boolean];
  enqueueMany: [songs: Song[], force?: boolean];
  details: [song: Song];
  status: [message: string, tone?: 'normal' | 'success' | 'error'];
}>();

let highlightTimer: number | undefined;

function findNext() {
  const id = props.catalog.nextMatch();
  if (!id) {
    emit('status', props.catalog.searchQuery.value.trim() ? '没有找到匹配歌曲' : '请输入歌曲名、专辑或艺术家', 'normal');
    return;
  }
  window.clearTimeout(highlightTimer);
  void nextTick(() => {
    document.querySelector(`[data-song-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  highlightTimer = window.setTimeout(() => { props.catalog.highlightedId.value = ''; }, 1800);
}

function handleSearchInput() {
  props.catalog.clearSearch();
}

function downloadAll() {
  emit('enqueueMany', props.catalog.songs.value);
}

function downloadAlbum(song: Song) {
  const albumSongs = props.catalog.songs.value.filter((item) => item.albumCid === song.albumCid);
  if (albumSongs.length) emit('enqueueMany', albumSongs, true);
}

async function reloadCatalog() {
  await props.catalog.load();
  emit(
    'status',
    props.catalog.errorMessage.value || '官网目录已更新',
    props.catalog.errorMessage.value ? (props.catalog.previewData.value ? 'normal' : 'error') : 'success'
  );
}

onBeforeUnmount(() => window.clearTimeout(highlightTimer));
</script>

<template>
  <section class="library-page" aria-labelledby="library-heading">
    <div class="library-hero">
      <div><h1 id="library-heading">音乐库</h1></div>
      <div class="library-count" :title="recordScope">
        <strong>{{ catalog.downloadedCount.value }}</strong>
        <span>{{ recordScope }} / {{ catalog.songs.value.length }} 首</span>
      </div>
    </div>

    <div class="library-toolbar">
      <form class="search-form" @submit.prevent="findNext">
        <span class="search-symbol" aria-hidden="true">⌕</span>
        <input
          v-model="catalog.searchQuery.value"
          type="search"
          name="song-search"
          autocomplete="off"
          placeholder="搜索歌曲、专辑或艺术家…"
          aria-label="搜索歌曲、专辑或艺术家"
          @input="handleSearchInput"
        />
        <span v-if="catalog.searchQuery.value.trim()" class="search-count" aria-live="polite">{{ catalog.matchCount.value }} 项</span>
        <button v-if="catalog.searchQuery.value" type="button" class="search-clear" aria-label="清除搜索" @click="catalog.searchQuery.value = ''; catalog.clearSearch()">清除</button>
        <button type="submit" class="search-submit">定位</button>
      </form>
      <div class="filter-tabs" aria-label="歌曲分类">
        <button type="button" :aria-pressed="catalog.filter.value === 'all'" :class="{ active: catalog.filter.value === 'all' }" @click="catalog.filter.value = 'all'">全部 <span>{{ catalog.songs.value.length }}</span></button>
        <button type="button" :aria-pressed="catalog.filter.value === 'pending'" :class="{ active: catalog.filter.value === 'pending' }" @click="catalog.filter.value = 'pending'">未下载 <span>{{ catalog.songs.value.length - catalog.downloadedCount.value }}</span></button>
        <button type="button" :aria-pressed="catalog.filter.value === 'downloaded'" :class="{ active: catalog.filter.value === 'downloaded' }" @click="catalog.filter.value = 'downloaded'">已下载 <span>{{ catalog.downloadedCount.value }}</span></button>
      </div>
      <button type="button" class="download-all-action" :disabled="!catalog.pendingSongs.value.length" @click="downloadAll">ALL!（下载全部）</button>
    </div>

    <div v-if="catalog.loading.value" class="empty-state">正在读取歌曲目录…</div>
    <div v-else-if="!catalog.visibleSongs.value.length && catalog.errorMessage.value" class="catalog-error" role="alert">
      <strong>官网数据加载失败</strong>
      <span>{{ catalog.errorMessage.value }}</span>
      <button type="button" class="outline-action" @click="reloadCatalog">重新获取</button>
    </div>
    <div v-else-if="!catalog.visibleSongs.value.length" class="empty-state">
      <strong>{{ catalog.searchQuery.value.trim() ? '没有匹配的歌曲' : '这里还没有歌曲' }}</strong>
      <span>{{ catalog.searchQuery.value.trim() ? '请修改关键词，或清除搜索后重试。' : '切换分类后再查看。' }}</span>
    </div>

    <div v-else class="song-groups">
      <section v-if="!groupByDownload" class="song-group">
        <header class="song-group-header">
          <div><span class="group-dot pending-dot" aria-hidden="true"></span><strong>全部歌曲</strong><small>{{ catalog.visibleSongs.value.length }} 首</small></div>
          <button type="button" class="text-action" :disabled="!catalog.pendingSongs.value.length" @click="emit('enqueueMany', catalog.visibleSongs.value)">下载当前结果</button>
        </header>
        <div class="song-table" role="list">
          <SongRow v-for="(song, index) in catalog.visibleSongs.value" :key="song.cid" :song="song" :index="index" :downloaded="catalog.downloadedIds.value.has(song.cid)" :highlighted="catalog.highlightedId.value === song.cid" @details="emit('details', $event)" @download="emit('enqueue', $event, catalog.downloadedIds.value.has($event.cid))" @album="downloadAlbum" />
        </div>
      </section>

      <template v-else>
        <section v-if="catalog.filter.value !== 'downloaded' && catalog.pendingSongs.value.length" class="song-group">
          <header class="song-group-header">
            <div><span class="group-dot pending-dot" aria-hidden="true"></span><strong>未下载</strong><small>{{ catalog.pendingSongs.value.length }} 首</small></div>
            <button type="button" class="text-action" @click="emit('enqueueMany', catalog.pendingSongs.value)">下载本组</button>
          </header>
          <div class="song-table" role="list">
            <SongRow v-for="(song, index) in catalog.pendingSongs.value" :key="song.cid" :song="song" :index="index" :downloaded="false" :highlighted="catalog.highlightedId.value === song.cid" @details="emit('details', $event)" @download="emit('enqueue', $event)" @album="downloadAlbum" />
          </div>
        </section>

        <section v-if="catalog.filter.value !== 'pending' && catalog.downloadedSongs.value.length" class="song-group downloaded-group">
          <header class="song-group-header"><div><span class="group-dot downloaded-dot" aria-hidden="true"></span><strong>已下载</strong><small>{{ catalog.downloadedSongs.value.length }} 首</small></div></header>
          <div class="song-table" role="list">
            <SongRow v-for="(song, index) in catalog.downloadedSongs.value" :key="song.cid" :song="song" :index="index" :downloaded="true" :highlighted="catalog.highlightedId.value === song.cid" @details="emit('details', $event)" @download="emit('enqueue', $event, true)" @album="downloadAlbum" />
          </div>
        </section>
      </template>
    </div>

    <p v-if="catalog.errorMessage.value" class="catalog-note" :data-preview="catalog.previewData.value">{{ catalog.errorMessage.value }}</p>
  </section>
</template>
