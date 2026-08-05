<script setup lang="ts">
import { formatDuration, type Song } from '../catalog';

defineProps<{
  song: Song;
  index: number;
  downloaded: boolean;
  highlighted: boolean;
}>();

const emit = defineEmits<{
  details: [song: Song];
  download: [song: Song, force: boolean];
  album: [song: Song];
}>();
</script>

<template>
  <article
    class="song-row"
    :class="{ 'downloaded-row': downloaded, 'search-match': highlighted }"
    role="listitem"
    :data-song-id="song.cid"
  >
    <span class="song-number">{{ String(index + 1).padStart(2, '0') }}</span>
    <div class="song-main"><strong>{{ song.name }}</strong><span>{{ song.artist || '塞壬唱片' }}</span></div>
    <div class="song-album">{{ song.albumName }}</div>
    <time>{{ formatDuration(song.duration) }}</time>
    <div class="song-actions">
      <button type="button" class="icon-action" title="歌曲详情" @click="emit('details', song)">详情</button>
      <button type="button" class="outline-action" @click="emit('album', song)">下载专辑</button>
      <button type="button" :class="downloaded ? 'outline-action' : 'primary-action'" @click="emit('download', song, downloaded)">
        {{ downloaded ? '重新下载' : '下载' }}
      </button>
    </div>
  </article>
</template>
