<script setup lang="ts">
import { ref, watch } from 'vue';
import { formatDuration, type Song } from '../catalog';

const props = defineProps<{ song: Song | null }>();
const emit = defineEmits<{ close: [] }>();
const coverUnavailable = ref(false);

watch(() => props.song?.cid, () => { coverUnavailable.value = false; });
</script>

<template>
  <Transition name="modal-fade">
    <div v-if="song" class="modal-layer" @click.self="emit('close')">
      <section class="detail-modal" role="dialog" aria-modal="true" aria-labelledby="song-detail-heading">
        <button type="button" class="drawer-close" aria-label="关闭歌曲详情" @click="emit('close')">×</button>
        <div class="detail-cover" :class="{ empty: coverUnavailable || !song.coverUrl }">
          <img v-if="song.coverUrl && !coverUnavailable" :src="song.coverUrl" :alt="`${song.albumName} 封面`" @error="coverUnavailable = true" />
          <span v-else aria-hidden="true">SR</span>
        </div>
        <div class="detail-copy">
          <p class="section-label">TRACK DETAIL</p>
          <h2 id="song-detail-heading">{{ song.name }}</h2>
          <p class="detail-subtitle">{{ song.albumName }}</p>
          <dl class="detail-facts"><div><dt>艺术家</dt><dd>{{ song.artist || '塞壬唱片' }}</dd></div><div><dt>时长</dt><dd>{{ formatDuration(song.duration) }}</dd></div><div><dt>歌曲 CID</dt><dd>{{ song.cid }}</dd></div></dl>
        </div>
      </section>
    </div>
  </Transition>
</template>
