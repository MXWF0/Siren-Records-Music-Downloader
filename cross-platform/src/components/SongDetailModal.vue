<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { formatDuration, normalizeDuration, type Song } from '../catalog';

const props = defineProps<{
  song: Song | null;
  loadDetails?: (id: string) => Promise<unknown>;
}>();
const emit = defineEmits<{ close: []; download: [song: Song] }>();
const coverUnavailable = ref(false);
const loading = ref(false);
const errorMessage = ref('');
const detail = ref<Record<string, unknown>>({});
const dialog = ref<HTMLElement>();
let detailRequest = 0;
let previousBodyOverflow = '';

const artist = computed(() => {
  if (typeof detail.value.artist === 'string') return detail.value.artist;
  if (Array.isArray(detail.value.artists)) return detail.value.artists.filter((value) => typeof value === 'string').join(' / ');
  return props.song?.artist || '塞壬唱片-MSR';
});
const duration = computed(() => normalizeDuration(detail.value.duration) ?? normalizeDuration(props.song?.duration));
const coverUrl = computed(() => {
  const remote = typeof detail.value.coverUrl === 'string' ? detail.value.coverUrl : '';
  return remote || props.song?.coverUrl || props.song?.coverDeUrl || '';
});

async function refreshDetail(song: Song) {
  const request = ++detailRequest;
  detail.value = {};
  errorMessage.value = '';
  coverUnavailable.value = false;
  await nextTick();
  dialog.value?.focus();
  if (!props.loadDetails) return;
  loading.value = true;
  try {
    const value = await props.loadDetails(song.cid);
    if (request === detailRequest && value && typeof value === 'object') detail.value = value as Record<string, unknown>;
  } catch (error) {
    if (request === detailRequest) errorMessage.value = error instanceof Error ? error.message : '暂时无法读取更多歌曲信息';
  } finally {
    if (request === detailRequest) loading.value = false;
  }
}

function focusableElements() {
  if (!dialog.value) return [];
  return Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
}

function handleKeydown(event: KeyboardEvent) {
  if (!props.song) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = focusableElements();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function restorePageInteraction() {
  document.body.style.overflow = previousBodyOverflow;
}

watch(() => props.song, (song, previous) => {
  if (song) {
    if (!previous) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    void refreshDetail(song);
  } else {
    detailRequest += 1;
    restorePageInteraction();
  }
}, { immediate: true });

window.addEventListener('keydown', handleKeydown);
onBeforeUnmount(() => {
  detailRequest += 1;
  window.removeEventListener('keydown', handleKeydown);
  restorePageInteraction();
});
</script>

<template>
  <Transition name="modal-fade">
    <div v-if="song" class="modal-layer" @click.self="emit('close')">
      <section ref="dialog" class="detail-modal" role="dialog" aria-modal="true" aria-labelledby="song-detail-heading" aria-describedby="song-detail-label" tabindex="-1">
        <button type="button" class="drawer-close" aria-label="关闭歌曲详情" @click="emit('close')">×</button>
        <div class="detail-cover" :class="{ empty: coverUnavailable || !coverUrl }">
          <img v-if="coverUrl && !coverUnavailable" :src="coverUrl" :alt="`${song.albumName} 封面`" width="360" height="360" fetchpriority="high" @error="coverUnavailable = true" />
          <span v-else aria-hidden="true">SR</span>
        </div>
        <div class="detail-copy">
          <p id="song-detail-label" class="section-label">TRACK DETAIL</p>
          <h2 id="song-detail-heading">{{ song.name }}</h2>
          <p class="detail-subtitle">{{ song.albumName }}</p>
          <p v-if="loading" class="detail-loading" aria-live="polite">正在读取官网详情…</p>
          <dl class="detail-facts">
            <div><dt>艺术家</dt><dd>{{ artist }}</dd></div>
            <div><dt>时长</dt><dd>{{ formatDuration(duration) }}</dd></div>
            <div><dt>专辑 CID</dt><dd>{{ song.albumCid }}</dd></div>
            <div><dt>歌曲 CID</dt><dd>{{ song.cid }}</dd></div>
          </dl>
          <p v-if="errorMessage" class="detail-error" role="status">{{ errorMessage }}</p>
          <button type="button" class="primary-action detail-download-action" @click="emit('download', song)">下载这首歌曲</button>
        </div>
      </section>
    </div>
  </Transition>
</template>
