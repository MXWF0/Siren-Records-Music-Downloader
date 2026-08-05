<script setup lang="ts">
import { ref } from 'vue';
import type { WindowControls } from '../platform/types';

defineProps<{
  activeView: 'library' | 'about';
  windowControls?: WindowControls;
}>();

const emit = defineEmits<{
  navigate: [view: 'library' | 'about'];
}>();

const maximized = ref(false);

async function toggleMaximize(windowControls?: WindowControls) {
  if (!windowControls) return;
  maximized.value = await windowControls.toggleMaximize();
}
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <button class="titlebar-brand no-drag" type="button" @click="emit('navigate', 'library')">
      <span class="brand-mark" aria-hidden="true">SR</span>
      <span class="titlebar-copy">
        <small>SIREN RECORDS</small>
      </span>
    </button>
    <strong class="titlebar-centered">塞壬唱片下载器</strong>

    <nav class="titlebar-nav no-drag" aria-label="主导航">
      <button type="button" :class="{ active: activeView === 'library' }" @click="emit('navigate', 'library')">音乐库</button>
      <button type="button" :class="{ active: activeView === 'about' }" @click="emit('navigate', 'about')">关于</button>
    </nav>

    <div v-if="windowControls" class="window-controls no-drag" aria-label="窗口控制">
      <button type="button" aria-label="最小化" title="最小化" @click="windowControls.minimize()">−</button>
      <button type="button" :aria-label="maximized ? '还原' : '最大化'" :title="maximized ? '还原' : '最大化'" @click="toggleMaximize(windowControls)">{{ maximized ? '❐' : '□' }}</button>
      <button class="window-close" type="button" aria-label="关闭" title="关闭" @click="windowControls.close()">×</button>
    </div>
  </header>
</template>
