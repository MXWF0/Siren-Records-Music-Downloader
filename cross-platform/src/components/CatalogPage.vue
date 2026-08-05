<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Song } from '../catalog';
import type { CatalogStore } from '../stores/catalog';
import SongRow from './SongRow.vue';

const props = defineProps<{
  catalog: CatalogStore;
  groupByDownload: boolean;
}>();

const emit = defineEmits<{
  enqueue: [song: Song, force?: boolean];
  enqueueMany: [songs: Song[], force?: boolean];
  details: [song: Song];
  status: [message: string, tone?: 'normal' | 'success' | 'error'];
}>();

const searchInput = ref<HTMLInputElement>();
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

function downloadSong(song: Song, force = false) {
  emit('enqueue', song, force);
}

function downloadGroup(songs: Song[]) {
  emit('enqueueMany', songs);
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
  if (props.catalog.errorMessage.value) {
    emit('status', props.catalog.errorMessage.value, props.catalog.previewData.value ? 'normal' : 'error');
  } else {
    emit('status', '官网目录已更新', 'success');
  }
}

watch(() => props.catalog.searchQuery.value, (value) => {
  if (!value.trim()) props.catalog.clearSearch();
});

onBeforeUnmount(() => window.clearTimeout(highlightTimer));
</script>

<template>
  <section class="library-page" aria-labelledby="library-heading">
    <div class="library-hero">
      <div>
        <h2 id="library-heading">音乐库</h2>
      </div>
      <div class="library-count">
        <strong>{{ catalog.downloadedIds.value.size }}</strong>
        <span>已下载 / {{ catalog.songs.value.length }} 首</span>
      </div>
    </div>

    <div class="library-toolbar">
      <form class="search-form" @submit.prevent="findNext">
        <span class="search-symbol" aria-hidden="true">⌕</span>
        <input ref="searchInput" v-model="catalog.searchQuery.value" type="search" placeholder="搜索歌曲、专辑或艺术家" aria-label="搜索歌曲" @input="handleSearchInput" />
        <button v-if="catalog.searchQuery.value" type="button" class="search-clear" aria-label="清除搜索" @click="catalog.searchQuery.value = ''; catalog.clearSearch()">清除</button>
        <button type="submit" class="search-submit">定位</button>
      </form>
      <div class="filter-tabs" role="tablist" aria-label="歌曲分类">
        <button type="button" :class="{ active: catalog.filter.value === 'all' }" @click="catalog.filter.value = 'all'">全部 <span>{{ catalog.songs.value.length }}</span></button>
        <button type="button" :class="{ active: catalog.filter.value === 'pending' }" @click="catalog.filter.value = 'pending'">未下载 <span>{{ catalog.songs.value.length - catalog.downloadedIds.value.size }}</span></button>
        <button type="button" :class="{ active: catalog.filter.value === 'downloaded' }" @click="catalog.filter.value = 'downloaded'">已下载 <span>{{ catalog.downloadedIds.value.size }}</span></button>
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
      <strong>这里还没有歌曲</strong>
      <span>{{ catalog.filter.value === 'downloaded' ? '下载完成后，歌曲会按目录顺序出现在这里。' : '换一个筛选条件或清空搜索内容。' }}</span>
    </div>
    <div v-else class="song-groups">
      <section v-if="!groupByDownload" class="song-group">
        <header class="song-group-header">
          <div><span class="group-dot pending-dot"></span><strong>全部歌曲</strong><small>{{ catalog.visibleSongs.value.length }} 首</small></div>
          <button type="button" class="text-action" :disabled="!catalog.pendingSongs.value.length" @click="downloadAll">下载全部</button>
        </header>
        <div class="song-table" role="list">
          <SongRow
            v-for="(song, index) in catalog.visibleSongs.value"
            :key="song.cid"
            :song="song"
            :index="index"
            :downloaded="catalog.downloadedIds.value.has(song.cid)"
            :highlighted="catalog.highlightedId.value === song.cid"
            @details="emit('details', $event)"
            @download="downloadSong"
            @album="downloadAlbum"
          />
        </div>
      </section>

      <template v-else>
        <section v-if="catalog.filter.value !== 'downloaded'" class="song-group">
          <header class="song-group-header">
            <div><span class="group-dot pending-dot"></span><strong>未下载</strong><small>{{ catalog.pendingSongs.value.length }} 首</small></div>
            <button type="button" class="text-action" :disabled="!catalog.pendingSongs.value.length" @click="downloadGroup(catalog.pendingSongs.value)">下载本组</button>
          </header>
          <div class="song-table" role="list">
            <SongRow
              v-for="(song, index) in catalog.pendingSongs.value"
              :key="song.cid"
              :song="song"
              :index="index"
              :downloaded="false"
              :highlighted="catalog.highlightedId.value === song.cid"
              @details="emit('details', $event)"
              @download="downloadSong"
              @album="downloadAlbum"
            />
          </div>
        </section>

        <section v-if="catalog.filter.value !== 'pending'" class="song-group downloaded-group">
          <header class="song-group-header">
            <div><span class="group-dot downloaded-dot"></span><strong>已下载</strong><small>{{ catalog.downloadedSongs.value.length }} 首</small></div>
          </header>
          <div v-if="catalog.downloadedSongs.value.length" class="song-table" role="list">
            <SongRow
              v-for="(song, index) in catalog.downloadedSongs.value"
              :key="song.cid"
              :song="song"
              :index="index"
              :downloaded="true"
              :highlighted="catalog.highlightedId.value === song.cid"
              @details="emit('details', $event)"
              @download="downloadSong"
              @album="downloadAlbum"
            />
          </div>
          <div v-else class="group-empty">下载完成的歌曲会按时间和目录顺序显示在这里。</div>
        </section>
      </template>
    </div>

    <p v-if="catalog.errorMessage.value" class="catalog-note" :data-preview="catalog.previewData.value">{{ catalog.errorMessage.value }}</p>
  </section>
</template>
